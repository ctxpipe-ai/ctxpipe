import { createHash } from "node:crypto"
import { posix } from "node:path"

import {
  resolveHydrateLink,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import {
  markdownBodyOf,
  markdownDestinations,
  relativeLinkUrl,
} from "../domain/workspaces/native-rename-rewrite.js"
import type {
  DocumentStatus,
  KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import {
  fetchGitCommits,
  readGitBlobs,
  withGitDirectory,
} from "../services/git/pack.js"
import { isKnowledgePath } from "./parse-file.js"
import { type KnowledgeRemote, regularFiles } from "./writer.js"

/** One document that the maintenance job found. */
type KnowledgeFinding = {
  status: "missing" | "deleted" | "failed"
  /** The SHA-256 of the document key, first 16 hex characters. */
  doc: string
  /**
   * The file of a `failed` document, or the file that refers to a `missing`
   * or `deleted` document. Empty when no file of the tree has the key.
   */
  path: string
  /** The resolved path of a body link to the document. Empty for a reference that is not a body link. */
  target: string
  /** For a body link to a `missing` document: the count of files with the same file name. */
  matches?: number
}

/**
 * The checks of the knowledge maintenance job (ADR-067 decision 9) for one
 * Workspace at `sha`, the `last_sha` of its knowledge state. The job reads
 * the rows and the Git tree. It writes no row and no file: it gives the
 * findings and the changed files.
 *
 * The one safe fix: a body link to a `missing` document, when exactly one
 * file of the tree has the same file name, points to that file. Each other
 * finding is a report only:
 * - a `failed` document (a file that does not parse);
 * - a reference to a `deleted` document;
 * - a reference to a `missing` document with no file or more than one file
 *   of that name, or with no body link (a claim or a `sources` entry).
 */
export async function findKnowledgeRepairs(input: {
  orgId: string
  workspaceId: string
  remote: KnowledgeRemote
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  sha: string
  /** The job only reads. */
  store: Pick<KnowledgeStore, "listDocumentKeys" | "readFrontier">
}): Promise<{
  counts: Record<DocumentStatus, number>
  findings: KnowledgeFinding[]
  /** The files with rewritten links, root-relative. */
  files: { path: string; content: string }[]
}> {
  const { orgId, workspaceId, sha, store } = input
  // A key with a tombstone and an old row gives the old row, as in the
  // writer.
  const statuses = new Map<string, DocumentStatus>()
  for (const { docKey, status } of await store.listDocumentKeys({
    orgId,
    workspaceId,
  }))
    if (status !== "deleted" || !statuses.has(docKey))
      statuses.set(docKey, status)
  const keysWith = (status: DocumentStatus) =>
    [...statuses].flatMap(([key, value]) => (value === status ? [key] : []))
  const counts = { active: 0, deleted: 0, missing: 0, failed: 0 }
  for (const status of statuses.values()) counts[status] += 1

  // The `missing` and `deleted` documents that each active file refers to.
  const referred = new Map<string, Set<string>>()
  const targets = [...keysWith("missing"), ...keysWith("deleted")]
  for (let at = 0; at < targets.length; at += 500) {
    const relations = await store.readFrontier(
      { orgId, workspaceIds: [workspaceId] },
      targets.slice(at, at + 500).map((docKey) => ({ workspaceId, docKey })),
    )
    for (const { direction, relation, neighbor } of relations) {
      if (direction !== "in" || neighbor?.status !== "active") continue
      const keys = referred.get(neighbor.path) ?? new Set<string>()
      keys.add(relation.dstDoc)
      referred.set(neighbor.path, keys)
    }
  }

  return withGitDirectory(
    sha,
    async (directory) => {
      await fetchGitCommits(directory, {
        url: input.remote.url,
        shas: [sha],
        token: await input.remote.token(),
      })
      const tree = await regularFiles(directory, sha, input.root)
      const keyOf = (path: string) =>
        servingIdForKnowledgePath(workspaceId, path)
      const pathOf = new Map(
        [...tree.keys()].map((path) => [keyOf(path), path]),
      )
      const named = new Map<string, string[]>()
      for (const path of tree.keys()) {
        const name = posix.basename(path)
        named.set(name, [...(named.get(name) ?? []), path])
      }

      const findings: KnowledgeFinding[] = keysWith("failed").map((docKey) => ({
        status: "failed",
        doc: hashKey(docKey),
        path: pathOf.get(docKey) ?? "",
        target: "",
      }))
      const files: { path: string; content: string }[] = []
      const sources = [...referred.keys()]
        .filter((path) => tree.has(path) && isKnowledgePath(path))
        .sort()
      const contents = await readGitBlobs(
        directory,
        sources.map((path) => tree.get(path) ?? ""),
      )
      for (const [index, path] of sources.entries()) {
        const content = contents[index]?.toString("utf8") ?? ""
        const keys = referred.get(path) ?? new Set<string>()
        const body = markdownBodyOf(content)
        // The folder of the file, as the writer resolves its links.
        const folder = path.split("/").slice(0, -1).join("/")
        const linked = new Set<string>()
        const edits: { start: number; end: number; value: string }[] = []
        for (const link of markdownDestinations(body)) {
          // The raw destination, as the writer reads it.
          const raw = body.slice(link.start, link.end)
          const target = resolveHydrateLink(folder, raw)
          const docKey = target ? keyOf(target) : ""
          if (!keys.has(docKey)) continue
          const status = statuses.get(docKey)
          const matches = named.get(posix.basename(target)) ?? []
          const [match] = matches
          if (status === "missing" && matches.length === 1 && match) {
            const anchor = raw.indexOf("#")
            edits.push({
              start: link.start,
              end: link.end,
              value:
                relativeLinkUrl(path, match) +
                (anchor < 0 ? "" : raw.slice(anchor)),
            })
          }
          if (linked.has(docKey)) continue
          linked.add(docKey)
          findings.push({
            status: status === "missing" ? "missing" : "deleted",
            doc: hashKey(docKey),
            path,
            target,
            ...(status === "missing" ? { matches: matches.length } : {}),
          })
        }
        for (const docKey of keys)
          if (!linked.has(docKey))
            findings.push({
              status:
                statuses.get(docKey) === "missing" ? "missing" : "deleted",
              doc: hashKey(docKey),
              path,
              target: "",
            })
        if (!edits.length) continue
        let next = body
        for (const edit of edits.sort((a, b) => b.start - a.start))
          next = next.slice(0, edit.start) + edit.value + next.slice(edit.end)
        files.push({
          path,
          content: content.slice(0, content.length - body.length) + next,
        })
      }
      return { counts, findings, files }
    },
    undefined,
    null,
  )
}

/** A document key in a log: its key holds the hash of the path, so hash it again. */
const hashKey = (docKey: string) =>
  createHash("sha256").update(docKey).digest("hex").slice(0, 16)
