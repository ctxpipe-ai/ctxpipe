import { isUtf8 } from "node:buffer"
import { posix } from "node:path"
import { setImmediate } from "node:timers/promises"

import { isAlias, isMap, isScalar, isSeq } from "yaml"

import { parseNameStatus } from "../../services/git/name-status.js"
import {
  type GitPack,
  type GitRemoteRead,
  nativeGit,
  packRootTree,
  withGitDirectory,
} from "../../services/git/pack.js"
import { resolveHydrateLink, sourcePathOf } from "./hydrate.js"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import {
  isLinkedRepositoryDeclaration,
  parseSimpleFrontMatter,
} from "./layout.js"
import {
  applyBodyEdits,
  markdownBodyOf,
  markdownDestinations,
} from "./markdown-links.js"

type Rename = { from: string; to: string }

function renamePairs(output: Buffer): Rename[] {
  return parseNameStatus(output)
    .filter((change) => change.status.startsWith("R"))
    .map(({ from, to }) => ({ from, to }))
}

/** Compare immutable trees with Git's similarity scoring, including hidden competing sources. */
export async function nativeRenameRewriteFiles(
  pack: GitPack,
  previousSha: string,
  read: GitRemoteRead | null,
) {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const filesAt = async (sha: string) => {
        const entries = (await nativeGit(directory, ["ls-tree", "-rz", sha]))
          .toString()
          .split("\0")
        const files = new Map<string, string>()
        for (const entry of entries) {
          const match = /^(100644|100755) blob ([0-9a-f]+)\t(.*\.md)$/.exec(
            entry,
          )
          if (
            !match?.[2] ||
            !match[3] ||
            match[3] === "AGENTS.md" ||
            match[3].startsWith(".agents/") ||
            isLinkedRepositoryDeclaration(match[3])
          )
            continue
          const blob = await nativeGit(directory, [
            "cat-file",
            "blob",
            match[2],
          ])
          if (blob.includes(0) || !isUtf8(blob)) continue
          const content = new TextDecoder("utf-8", { fatal: true }).decode(blob)
          if (!parseSimpleFrontMatter(content).malformed)
            files.set(match[3], content)
        }
        return files
      }
      // Both trees are the Workspace root folder, so paths are root-relative.
      const previousTree = await packRootTree(directory, {
        sha: previousSha,
        root: pack.root,
      })
      const currentTree = await packRootTree(directory, pack)
      if (!previousTree || !currentTree) return []
      const diff = [
        "diff",
        "--find-renames=50%",
        "--name-status",
        "-z",
        previousTree,
        currentTree,
      ]
      // Most commits rename nothing. Then no file can change, so read none:
      // a read of each file of a large Workspace takes minutes (CTX-1369).
      const pairs = renamePairs(await nativeGit(directory, diff))
      if (!pairs.length) return []
      const previous = await filesAt(previousTree)
      const current = await filesAt(currentTree)
      const candidates = pairs.filter(
        (pair) => previous.has(pair.from) && current.has(pair.to),
      )
      const deleted = [...previous.keys()].filter((path) => !current.has(path))
      const renames: Rename[] = []
      for (const candidate of candidates) {
        let ambiguous = false
        for (const from of deleted) {
          if (from === candidate.from) continue
          const matches = renamePairs(
            await nativeGit(directory, [
              "--literal-pathspecs",
              ...diff,
              "--",
              from,
              candidate.to,
            ]),
          )
          if (
            matches.some(
              (pair) => pair.from === from && pair.to === candidate.to,
            )
          ) {
            ambiguous = true
            break
          }
        }
        if (!ambiguous) renames.push(candidate)
      }
      // With no rename, no link, claim, or source can change.
      if (!renames.length) return []
      const changes: Array<{ path: string; content: string }> = []
      let lastYield = performance.now()
      for (const [path, content] of current) {
        // The rewrite of thousands of files is seconds of CPU. Give the
        // event loop a turn every 50 ms, so that the OpenWorkflow lease
        // heartbeat runs on time.
        if (performance.now() - lastYield >= 50) {
          await setImmediate()
          lastYield = performance.now()
        }
        const rewritten = rewriteDocument(
          path,
          content,
          renames,
          current,
          previous,
        )
        if (rewritten !== content) changes.push({ path, content: rewritten })
      }
      return changes
    },
    pack,
    read,
  )
}

function rewriteDocument(
  path: string,
  content: string,
  renames: Rename[],
  current: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string>,
): string {
  const oldPath = renames.find((pair) => pair.to === path)?.from ?? path
  const target = (url: string): string => {
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(url)) return url
    const split = url.search(/[?#]/)
    const pathname = split < 0 ? url : url.slice(0, split)
    const suffix = split < 0 ? "" : url.slice(split)
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return url
    }
    const resolved = resolveHydrateLink(posix.dirname(oldPath), decoded)
    const moved = renames.find((pair) => pair.from === resolved)?.to
    if (!moved && path === oldPath) return url
    const destination = moved ?? resolved
    if (!current.has(destination)) return url
    return relativeLinkUrl(path, destination) + suffix
  }
  const body = markdownBodyOf(content)
  const edits: Array<{ start: number; end: number; value: string }> = []
  const original =
    oldPath !== path
      ? parseSimpleFrontMatter(previous.get(oldPath) ?? "")
      : undefined
  const originalLinks = original ? markdownDestinations(original.body) : []
  for (const link of markdownDestinations(body)) {
    if (oldPath !== path) {
      const matches = originalLinks.filter(
        (previousLink) => previousLink.url === link.url,
      )
      if (!matches.length) continue
    }
    const changed = target(link.url)
    if (changed !== link.url)
      edits.push({ start: link.start, end: link.end, value: changed })
  }
  let next = applyBodyEdits(content, edits)
  const originalClaims = original?.attributes.claims
  const claimTarget = (url: string, index: number) =>
    oldPath !== path &&
    (!Array.isArray(originalClaims) || originalClaims[index]?.to !== url)
      ? url
      : target(url)
  const claims = parseSimpleFrontMatter(content).attributes.claims
  if (
    Array.isArray(claims) &&
    claims.some(
      (claim, index) =>
        typeof claim?.to === "string" &&
        claimTarget(claim.to, index) !== claim.to,
    )
  ) {
    next = updateKnowledgeMetadata(next, (document) => {
      const sequence = editableMetadataNode(document, "claims")
      if (!isSeq(sequence)) return
      for (let index = 0; index < sequence.items.length; index++) {
        let claim = sequence.items[index]
        if (isAlias(claim)) {
          claim = materializeMetadataAlias(document, claim)
          sequence.items[index] = claim
        }
        if (!isMap(claim)) continue
        const to = claim.get("to")
        if (typeof to === "string" && claimTarget(to, index) !== to)
          claim.set("to", claimTarget(to, index))
      }
    })
  }
  // `sources` holds source paths from the Workspace root (ADR-050), not
  // links from the file, so a renamed source file keeps its units.
  const movedSource = (entry: unknown): string | null => {
    const resolved = sourcePathOf(entry)
    if (!resolved) return null
    const moved = renames.find((pair) => pair.from === resolved)?.to
    return moved && current.has(moved) ? moved : null
  }
  const sources = parseSimpleFrontMatter(next).attributes.sources
  if (Array.isArray(sources) && sources.some((entry) => movedSource(entry))) {
    next = updateKnowledgeMetadata(next, (document) => {
      const sequence = editableMetadataNode(document, "sources")
      if (!isSeq(sequence)) return
      for (let index = 0; index < sequence.items.length; index++) {
        let item = sequence.items[index]
        if (isAlias(item)) item = materializeMetadataAlias(document, item)
        if (!isScalar(item)) continue
        const moved = movedSource(item.value)
        if (moved) sequence.set(index, moved)
      }
    })
  }
  return next
}

/** The encoded relative link from the file `from` to the file `to`. */
function relativeLinkUrl(from: string, to: string): string {
  return posix
    .relative(posix.dirname(from), to)
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")
}
