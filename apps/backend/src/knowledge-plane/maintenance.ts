import { createHash } from "node:crypto"
import { posix } from "node:path"

import { hostOnlyRefusal } from "../domain/workspaces/host-only.js"
import {
  resolveHydrateLink,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import {
  applyBodyEdits,
  markdownBodyOf,
  markdownDestinations,
} from "../domain/workspaces/markdown-links.js"
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
import { inBatches, type KnowledgeRemote, regularFiles } from "./writer.js"

/** One document that the maintenance job found. */
type KnowledgeFinding = {
  status: "missing" | "deleted" | "failed"
  /** The SHA-256 of the document key, first 16 hex characters. */
  doc: string
  /**
   * The file of a `failed` document, or the file that refers to a `missing`
   * or `deleted` document. Absent when no file of the tree has the key.
   */
  path?: string
  /** The resolved path of a body link to the document. Absent for a reference that is not a body link. */
  target?: string
  /** For a body link to a `missing` document: the count of files with the same file name. */
  matches?: number
  /** For a body link to a `missing` document: true when the job rewrote it. */
  fixed?: boolean
}

/**
 * The checks of the knowledge maintenance job (ADR-067 decision 9) for one
 * Workspace at `sha`, the `last_sha` of its knowledge state. The job reads
 * the rows and the Git tree. It writes no row and no file: it gives the
 * findings and the changed files.
 *
 * The one safe fix: a body link to a `missing` document, when exactly one
 * file of the tree has the same file name, points to that file. The new
 * destination is a plain relative path, because the hydrate does not decode
 * URL escapes: a path that needs an escape (a space, a parenthesis, `%`,
 * `#`, `?`) gets no fix. Each other finding is a report only:
 * - a `failed` document (a file that does not parse);
 * - a reference to a `deleted` document;
 * - a reference to a `missing` document with no file or more than one file
 *   of that name, or with no body link (a claim or a `sources` entry);
 * - a reference key (`ref:<key>`) that no document states (ADR-066
 *   decision 5): a missing link with no row of its own;
 * - a link in a host-only file, which a Workspace write cannot change.
 */
export async function findKnowledgeRepairs(input: {
  orgId: string
  workspaceId: string
  remote: KnowledgeRemote
  /** The Workspace root folder; `""` is the repository root. */
  root: string
  sha: string
  /** The job only reads. */
  store: Pick<
    KnowledgeStore,
    | "listDocumentKeys"
    | "readFrontier"
    | "listUnresolvedReferences"
    | "readDocuments"
  >
}): Promise<{
  /** The documents by status, and the reference keys with no document. */
  counts: Record<DocumentStatus | "missingKeys", number>
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
  const counts = {
    active: 0,
    deleted: 0,
    missing: 0,
    failed: 0,
    missingKeys: 0,
  }
  for (const status of statuses.values()) counts[status] += 1

  // The `missing` and `deleted` documents, and the reference keys with no
  // document, that each active file refers to.
  const referred = new Map<string, Set<string>>()
  const refer = (path: string, target: string) =>
    referred.set(path, (referred.get(path) ?? new Set<string>()).add(target))
  const targets = [...keysWith("missing"), ...keysWith("deleted")]
  await inBatches(targets, 500, async (batch) => {
    const relations = await store.readFrontier(
      { orgId, workspaceIds: [workspaceId] },
      batch.map((docKey) => ({ workspaceId, docKey })),
    )
    for (const { direction, relation, neighbor } of relations) {
      if (direction === "in" && neighbor?.status === "active")
        refer(neighbor.path, relation.dstDoc)
    }
  })
  const unresolved = await store.listUnresolvedReferences({
    orgId,
    workspaceId,
  })
  counts.missingKeys = new Set(unresolved.map((row) => row.dstDoc)).size
  await inBatches(unresolved, 500, async (batch) => {
    const targetsOf = new Map<string, string[]>()
    for (const { srcDoc, dstDoc } of batch)
      targetsOf.set(srcDoc, [...(targetsOf.get(srcDoc) ?? []), dstDoc])
    for (const { document } of await store.readDocuments(
      { orgId, workspaceIds: [workspaceId] },
      [...targetsOf.keys()].map((docKey) => ({ workspaceId, docKey })),
    ))
      if (document.status === "active")
        for (const target of targetsOf.get(document.docKey) ?? [])
          refer(document.path, target)
  })
  // No reference to fix and no failed file: the job reads no Git.
  if (referred.size === 0 && counts.failed === 0)
    return { counts, findings: [], files: [] }

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
        ...(pathOf.has(docKey) ? { path: pathOf.get(docKey) } : {}),
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
        // A Workspace write refuses a host-only file, so it gets no fix.
        const writable = hostOnlyRefusal([path]) === null
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
          // The new destination must resolve back to the one match. A
          // `workspace:` or other scheme link keeps its form, so it gets no
          // fix.
          const destination = match && posix.relative(folder || ".", match)
          // A link to a file that exists but is not a document (a script, for
          // example) also has a `missing` row: it is not broken.
          const fixed =
            writable &&
            status === "missing" &&
            !tree.has(target) &&
            matches.length === 1 &&
            !!destination &&
            resolveHydrateLink(folder, destination) === match &&
            !/^[a-z][a-z0-9+.-]*:/i.test(raw) &&
            !/[\s()<>%#?\\]/.test(destination)
          if (fixed) {
            const suffix = raw.search(/[?#]/)
            edits.push({
              start: link.start,
              end: link.end,
              value: destination + (suffix < 0 ? "" : raw.slice(suffix)),
            })
          }
          if (linked.has(docKey)) continue
          linked.add(docKey)
          findings.push({
            status: status === "missing" ? "missing" : "deleted",
            doc: hashKey(docKey),
            path,
            target,
            ...(status === "missing" ? { matches: matches.length, fixed } : {}),
          })
        }
        for (const docKey of keys)
          if (!linked.has(docKey))
            findings.push({
              status:
                statuses.get(docKey) === "deleted" ? "deleted" : "missing",
              doc: hashKey(docKey),
              path,
            })
        const next = applyBodyEdits(content, edits)
        if (next !== content) files.push({ path, content: next })
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
