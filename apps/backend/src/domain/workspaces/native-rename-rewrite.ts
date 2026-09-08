import { isUtf8 } from "node:buffer"
import { posix } from "node:path"
import { fromMarkdown } from "mdast-util-from-markdown"
import { isAlias, isMap, isSeq } from "yaml"
import {
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import { resolveHydrateLink } from "./hydrate.js"
import {
  editableMetadataNode,
  materializeMetadataAlias,
  updateKnowledgeMetadata,
} from "./knowledge-metadata.js"
import {
  isLinkedRepositoryDeclaration,
  parseSimpleFrontMatter,
} from "./layout.js"

type Rename = { from: string; to: string }

function renamePairs(output: Buffer): Rename[] {
  const fields = output.toString().split("\0")
  const pairs: Rename[] = []
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++] ?? ""
    const from = fields[i++] ?? ""
    if (/^[RC]/.test(status)) {
      const to = fields[i++] ?? ""
      if (status.startsWith("R")) pairs.push({ from, to })
    }
  }
  return pairs
}

/** Compare immutable trees with Git's similarity scoring, including hidden competing sources. */
export async function nativeRenameRewriteFiles(
  pack: GitPack,
  previousSha: string,
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
      const previous = await filesAt(previousSha)
      const current = await filesAt(pack.sha)
      const diff = [
        "diff",
        "--find-renames=50%",
        "--name-status",
        "-z",
        previousSha,
        pack.sha,
      ]
      const candidates = renamePairs(await nativeGit(directory, diff)).filter(
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
      const changes: Array<{ path: string; content: string }> = []
      for (const [path, content] of current) {
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
    const relative = posix.relative(posix.dirname(path), destination)
    return (
      relative
        .split("/")
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (character) =>
              `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join("/") + suffix
    )
  }
  const frontMatter =
    /^(\uFEFF?---[ \t]*\r?\n)((?:[\s\S]*?\r?\n)?)(---[ \t]*(?=\r?\n|$))([\s\S]*)$/.exec(
      content,
    )
  const body = frontMatter?.[4] ?? content
  const edits: Array<{ start: number; end: number; value: string }> = []
  const original = parseSimpleFrontMatter(previous.get(oldPath) ?? "")
  const originalLinks = markdownDestinations(original.body)
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
  let nextBody = body
  for (const edit of edits.sort((a, b) => b.start - a.start))
    nextBody =
      nextBody.slice(0, edit.start) + edit.value + nextBody.slice(edit.end)
  let next = frontMatter
    ? content.slice(0, content.length - body.length) + nextBody
    : nextBody
  const originalClaims = original.attributes.claims
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
  return next
}

function markdownDestinations(body: string) {
  const links: Array<{
    url: string
    start: number
    end: number
  }> = []
  const tree = fromMarkdown(body)
  const visit = (node: (typeof tree.children)[number]) => {
    if (
      node.type === "link" ||
      node.type === "image" ||
      node.type === "definition"
    ) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) {
        const source = body.slice(start, end)
        const span = destinationSpan(source, node.type === "definition")
        if (span)
          links.push({
            url: node.url,
            start: start + span.start,
            end: start + span.end,
          })
      }
    }
    if ("children" in node) for (const child of node.children) visit(child)
  }
  for (const node of tree.children) visit(node)
  return links
}

/** Positions come from the Markdown parser; scan only an already recognized link/definition. */
function destinationSpan(
  source: string,
  definition: boolean,
): { start: number; end: number } | null {
  let cursor = source.startsWith("![") ? 2 : source.startsWith("[") ? 1 : -1
  if (cursor < 0) return null
  let brackets = 1
  while (cursor < source.length && brackets) {
    const character = source[cursor++]
    if (character === "\\") cursor++
    else if (character === "[") brackets++
    else if (character === "]") brackets--
    else if (character === "`" && !definition) {
      let length = 1
      while (source[cursor] === "`") {
        length++
        cursor++
      }
      const closing = source.indexOf("`".repeat(length), cursor)
      if (closing >= 0) cursor = closing + length
    }
  }
  if (source[cursor++] !== (definition ? ":" : "(")) return null
  while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++
  const angle = source[cursor] === "<"
  if (angle) cursor++
  const start = cursor
  let parentheses = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === "\\") {
      cursor += 2
      continue
    }
    if (
      angle
        ? character === ">"
        : /\s/.test(character ?? "") || (character === ")" && parentheses === 0)
    )
      break
    if (!angle && character === "(") parentheses++
    if (!angle && character === ")") parentheses--
    cursor++
  }
  return cursor > start ? { start, end: cursor } : null
}
