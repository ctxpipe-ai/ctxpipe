import { readFileSync } from "node:fs"

import {
  type ClickHouseClient,
  ClickHouseError,
  ClickHouseLogLevel,
  createClient,
  TupleParam,
} from "@clickhouse/client"
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"

import { CONNECTOR_MIRROR_ROOTS } from "../domain/codeIngestion/connectorMirrorPaths.js"
import { LINEAR_ID_KEY_PREFIX } from "../domain/codeIngestion/referenceResolver.js"

/**
 * The per-query custom setting that holds the org of a statement. The row
 * policy and the CHECK constraint of each knowledge table compare `org_id`
 * with it (migrations/0001_knowledge_tables.sql).
 */
export const ORG_SETTING = "SQL_ctxpipe_org_id"

/**
 * The prefix of a relation target that is a reference key, not a document
 * key (ADR-066 decision 5). The read finds the documents of the key in
 * `doc_refs`. A document key is a hash, so it never has this prefix.
 */
export const REFERENCE_TARGET_PREFIX = "ref:"

/** The org and the Workspace of each statement. */
export type KnowledgeScope = { orgId: string; workspaceId: string }

/**
 * The knowledge tables. The migrations give the users their grants on these
 * tables, and a purge deletes from each of them.
 */
export const KNOWLEDGE_TABLES = [
  "documents",
  "chunks",
  "relations",
  "relations_in",
  "doc_refs",
  "image_texts",
  "trees",
] as const

/**
 * The rows of a purge: only the rows of one Workspace of the org, or all
 * rows of the org with `workspaceId: null`. The org purge must say so: a
 * missing Workspace id is not an org purge.
 */
export type PurgeScope = { orgId: string; workspaceId: string | null }

/** The count of rows that a purge deleted from each knowledge table. */
export type PurgeCounts = Record<(typeof KNOWLEDGE_TABLES)[number], number>

/** A part of a knowledge table, by its name in `system.parts`. */
export type PurgedPart = {
  table: (typeof KNOWLEDGE_TABLES)[number]
  part: string
}

/** The counts of a scope with no rows. */
export const NO_KNOWLEDGE_ROWS: Readonly<PurgeCounts> = {
  documents: 0,
  chunks: 0,
  relations: 0,
  relations_in: 0,
  doc_refs: 0,
  image_texts: 0,
  trees: 0,
}

export type DocumentStatus = "active" | "deleted" | "missing" | "failed"

export type KnowledgeDocument = {
  docKey: string
  kind: string
  status: DocumentStatus
  deletedAt: Date | null
  error: string
  title: string
  path: string
  sourceType: string
  source: string
  summary: string
  mime: string
  /**
   * The times of the document (`DocumentTimes`, CTX-1710). On a file
   * version, the times that the file states; on a read, the times of the
   * tree row, with the Git times of the path (`withGitTimes`).
   */
  createdAt: Date | null
  updatedAt: Date | null
  expiresAt: Date | null
  /**
   * The start of the projection run that first wrote the file version. It
   * is internal: no agent sees it, and no ranking uses it (CTX-1710).
   */
  observedAt: Date
}

export type KnowledgeChunk = {
  ordinal: number
  text: string
  /** The 1-based file lines of the chunk, inclusive. 0 when it has none. */
  startLine: number
  endLine: number
  /** The full vector. The server stores it as BFloat16. */
  embedding: number[]
  /**
   * The key of the vector (`embeddingKey`), for its reuse by a later write
   * ({@link KnowledgeStore.readEmbeddings}). Absent: the vector is never
   * reused.
   */
  embeddingKey?: string
}

export type KnowledgeRelation = {
  srcDoc: string
  srcChunk: number
  predicate: string
  dstDoc: string
  confidence: number
  validFrom: Date | null
  validTo: Date | null
  source: string
  /**
   * The alt text of an image reference, on its `EMBEDS_IMAGE` relation
   * (ADR-066 decision 6). Empty on each other relation.
   */
  altText: string
  observedAt: Date
}

/**
 * The head of the tree of one branch (ADR-071 decision 4): the branch and
 * the tree version that its last completed run wrote.
 */
export type TreeHead = { branch: string; treeVersion: number }

/** The head that a read uses for one Workspace. */
export type WorkspaceHead = TreeHead & {
  workspaceId: string
  /**
   * For a branch that is not the default branch: the head of the default
   * branch. The tree of `branch` is then an overlay on it (ADR-071
   * decision 5).
   */
  base?: TreeHead
  /**
   * The count of the tree rows of the head after the first row of their
   * folded path (CTX-1697). A read of a default branch with 0 does not
   * fold. Absent or null: not known, so the read folds.
   */
  caseDuplicateRows?: number | null
}

/**
 * The key of a file version (ADR-071 decision 2): the document key of its
 * path, and its version (a hash of the blob SHA and the variant).
 */
export type FileVersionKey = { docKey: string; version: string }

/**
 * The fields of a document that the content of its file gives. The tree
 * gives the status of the path and `deletedAt` (ADR-071 decision 3).
 * Its times are the times that the file states (`documentTimes`): the tree
 * row adds the Git times of the path on its branch (`withGitTimes`).
 */
export type FileDocument = Omit<
  KnowledgeDocument,
  "status" | "deletedAt" | "error"
>

/**
 * A relation that a file version states. With `validFromIntroduced`, the
 * read takes `validFrom` from the tree row of the source: the source time
 * of the file, else the time of the commit that introduced the file on the
 * branch.
 */
export type FileRelation = Omit<KnowledgeRelation, "srcDoc"> & {
  validFromIntroduced: boolean
}

/** The rows of one document: the relations that it states are its own. */
export type DocumentRows = {
  document: FileDocument
  chunks: KnowledgeChunk[]
  relations: FileRelation[]
  /** The reference keys that the document states for itself. Absent: none. */
  refKeys?: string[]
}

/**
 * The rows of one file version. With `error`, it is a `failed` file version
 * (ADR-067 decision 8): it has no chunks and no relations.
 */
export type FileVersionRows = DocumentRows & {
  version: string
  error?: string
}

/** The fields of a stored file version that a tree row copies. */
export type StoredFileVersion = {
  status: "active" | "failed"
  kind: string
  observedAt: Date
  /** The times that the file states (`FileDocument`). */
  createdAt: Date | null
  updatedAt: Date | null
  expiresAt: Date | null
}

/**
 * One tree row (ADR-071 decision 3): the file version of a path on a
 * branch, or a tombstone (`deletedAt` is set) that keeps the last file
 * version of the path. Its times are the times of the file version with the
 * Git times of the path on the branch (`withGitTimes`).
 */
export type TreeEntry = FileVersionKey &
  StoredFileVersion & {
    path: string
    deletedAt: Date | null
    /**
     * An overlay row that takes the path out of the overlay: the view of
     * the branch shows the row of the default branch (ADR-071 decision 3).
     */
    inherit?: boolean
  }

/** The count of the mutations (DELETEs) that a caller made. */
export type MutationCounter = { mutations: number }

/** The org and the heads of a read. A read can span Workspaces. */
export type KnowledgeReadScope = { orgId: string; heads: WorkspaceHead[] }

/** The documents that the search of the store gives, at most. */
const SEARCH_HITS = 50

/** One document of a Workspace. */
export type DocumentRef = { workspaceId: string; docKey: string }

export type SearchQuery = {
  /**
   * The query vector, in the vector space of the chunks. A promise lets the
   * lexical query start while the embedding call is on its way (CTX-1576).
   */
  vector: number[] | PromiseLike<number[]>
  /**
   * The query terms for the text index. A term with separators counts as its
   * tokens. The match is case-sensitive.
   */
  terms: string[]
  /** Only documents of these kinds. Empty or absent: all kinds. */
  kinds?: string[]
  /** Only documents with a path that starts with this text. */
  pathPrefix?: string
  /**
   * Only documents from these sources: a connector mirror root (the first
   * folder of the path, for example `linear`), or `authored` for a path
   * outside the mirror roots. Empty or absent: all.
   */
  sources?: string[]
  /** Only documents with an `updatedAt` after this time. */
  updatedAfter?: Date | null
  /** The best chunks of each found document that the hit holds, at most. */
  chunksPerDocument: number
  /**
   * The neighbors of the best hits (CTX-1605): the documents that the first
   * `from` hits have a relation to, in either direction, except a
   * `FROM_SOURCE` relation, as the walk of `get_related` with no named
   * predicate. A neighbor must pass the filters of the search and not be a
   * hit. The `places` neighbors closest to the query vector (their closest
   * chunk) take the last places of the hits. Absent, or `places` 0: no
   * neighbors. When `signal` aborts before the read of the neighbors ends,
   * the search gives its hits without neighbors.
   */
  neighbors?: { from: number; places: number; signal?: AbortSignal }
}

/** A chunk of a read, with its text and its file lines. */
type ChunkLines = Omit<KnowledgeChunk, "embedding">

/** A document that the search found, with its found chunks, best first. */
type SearchHit = {
  workspaceId: string
  document: KnowledgeDocument
  /** The found chunks with their RRF scores, best first. */
  chunks: (ChunkLines & { score: number })[]
}

/**
 * A relation of a frontier document, and the document at its other end. A
 * relation to a reference key comes one time for each document of the key,
 * with that document as `dstDoc`. A target with no tree row is a `missing`
 * neighbor (ADR-071 decision 5).
 */
export type FrontierRelation = {
  /** `out`: the frontier document is `srcDoc`. `in`: it is `dstDoc`. */
  direction: "out" | "in"
  workspaceId: string
  relation: KnowledgeRelation
  /**
   * The confidence that the file states for the relation. It is the
   * confidence of `relation`, except for a `MENTIONS` of a reference key:
   * the read weighs that one by its key (ADR-066 decision 5).
   */
  statedConfidence: number
  neighbor: KnowledgeDocument
}

/** A document with its chunks closest to the query vector, closest first. */
type Evidence = {
  workspaceId: string
  document: KnowledgeDocument
  chunks: (ChunkLines & { distance: number })[]
}

type KnowledgeGraph = {
  documents: KnowledgeDocument[]
  relations: KnowledgeRelation[]
  truncated: boolean
}

/** The reading of one image by one vision model (`image_texts`). */
export type ImageTextRow = {
  blobSha: string
  /** The vision model of the request (`MODEL_VISION_NAME`). */
  model: string
  promptVersion: number
  /** The JSON of the structured reading. */
  reading: string
}

/** What one cleanup deleted. */
type CleanupCounts = { treeRows: number; fileVersions: number }

/**
 * The only ClickHouse client of the knowledge content (ADR-066). Each
 * function takes the org and one or more Workspaces of it, and each statement
 * has org walls:
 * - Reads: `org_id` and `workspace_id` are in the WHERE clause, and the row
 *   policy filters to the org of {@link ORG_SETTING}.
 * - Inserts: this module sets `org_id` and `workspace_id` of each row from
 *   the scope, and the CHECK constraint refuses a row of another org.
 * - DELETE: ClickHouse applies neither the row policy nor the CHECK
 *   constraint. Thus a caller gives only keys, and {@link deleteWhere} adds
 *   the org and Workspace predicates to each statement. The backend connects
 *   as a user with SELECT only (ADR-066 decision 9).
 *
 * The content tables hold file versions, and the tree table says which file
 * version each branch holds at each path (ADR-071). A file version and a
 * tree row are written one time. Only the deletion of the rows of a stopped
 * run ({@link KnowledgeStore.deleteTreeAbove}) and the cleanup make DELETEs.
 */
export type KnowledgeStore = {
  /**
   * The stored file versions of `keys`, by {@link fileVersionId}, with the
   * fields that a tree row copies. A file version whose document row is not
   * stored is not stored: a write inserts that row last.
   */
  findFileVersions(
    scope: KnowledgeScope,
    keys: FileVersionKey[],
  ): Promise<Map<string, StoredFileVersion>>
  /**
   * Inserts the rows of each file version. A version with rows but no
   * document row is the rest of a write that stopped: those rows are
   * deleted first, so that a retry does not store them two times. The
   * document row goes in last.
   */
  writeFileVersions(
    scope: KnowledgeScope,
    versions: FileVersionRows[],
    counter?: MutationCounter,
  ): Promise<void>
  /** The tree rows that `head` shows: one row for each path that has one. */
  readTree(scope: KnowledgeScope, head: TreeHead): Promise<TreeEntry[]>
  /**
   * True when `head` shows at least one tree row, a tombstone included. A
   * head of the default branch with no row lost its rows, or its tree has
   * no document file (ADR-067 decision 8).
   */
  hasTree(scope: KnowledgeScope, head: TreeHead): Promise<boolean>
  /**
   * Inserts `entries` with the tree version `treeVersion` of `branch`. No
   * read sees them until the head of the branch moves to that version.
   */
  writeTree(
    scope: KnowledgeScope,
    branch: string,
    treeVersion: number,
    entries: TreeEntry[],
  ): Promise<void>
  /**
   * Deletes the tree rows of `branch` above `treeVersion`: the rows of a run
   * that stopped before it moved the head (ADR-071 decision 4).
   */
  deleteTreeAbove(
    scope: KnowledgeScope,
    branch: string,
    treeVersion: number,
    counter?: MutationCounter,
  ): Promise<void>
  /**
   * Deletes (ADR-071 decision 10):
   * - the tree rows of a branch that is not in `heads`, when its newest row
   *   was written before `replacedBefore`;
   * - each tree row that a newer row at or below the head replaced, when
   *   that newer row was written before `replacedBefore`;
   * - each file version that no tree row uses, when its newest row was
   *   written before `unusedBefore`.
   * The writer inserts all tree rows of a run in one INSERT, just before it
   * moves the head (`applyChangeSet`, then `completeKnowledgeRun`). Thus the
   * `written_at` of a tree row is the time when its tree version became
   * visible, within the time of one Postgres update, and each grace time
   * counts from the publication of a head. The caller holds the projection
   * lease of the Workspace, so that no run uses a file version while it is
   * deleted.
   */
  cleanUp(
    scope: KnowledgeScope,
    input: { heads: TreeHead[]; replacedBefore: Date; unusedBefore: Date },
    counter?: MutationCounter,
  ): Promise<CleanupCounts>
  /**
   * Deletes all rows of the org of `scope` from each knowledge table, or
   * only the rows of its Workspace when `scope` has one. This is the
   * deletion of an org or a Workspace (CTX-1642). Each table gets at most
   * one DELETE, with the org predicate and, for a Workspace, the Workspace
   * predicate. A table with no rows of the scope gets none. A purge that
   * runs again deletes nothing more. The caller makes sure that no
   * projection run of the scope writes during or after the purge.
   */
  purge(scope: PurgeScope): Promise<PurgeCounts>
  /**
   * The active parts that hold rows of `scope`, also rows that a DELETE
   * hid. Read them after {@link purge} and before {@link erasePurged}:
   * {@link partsLeft} then tells when ClickHouse removed them (CTX-1672).
   */
  findPurgedParts(scope: PurgeScope): Promise<PurgedPart[]>
  /**
   * After {@link purge}: makes ClickHouse rewrite each part that holds a
   * deleted row of `scope`, without its deleted rows (CTX-1672). A DELETE
   * only hides a row, and its bytes stay in the part, also on the cold
   * volume, until a merge rewrites the part. Each table gets one
   * `APPLY DELETED MASK` for each month partition with rows of the scope,
   * so that a part of another month stays as it is. The mutations run in
   * the background. Returns the count of mutations.
   */
  erasePurged(scope: PurgeScope): Promise<number>
  /**
   * The count of rows of `scope` that the active parts of the knowledge
   * tables hold, also the rows that a DELETE hid.
   */
  purgedRowsInParts(scope: PurgeScope): Promise<number>
  /**
   * The count of `parts` (from {@link findPurgedParts}) that are still on
   * the disk, active or replaced. ClickHouse removes a replaced part some
   * minutes after the mutation that replaced it.
   */
  partsLeft(parts: PurgedPart[]): Promise<number>
  /**
   * The stored vector of each key of `embeddingKeys` that a chunk of a
   * document of `docKeys` has (any file version), in the Workspace of
   * `scope` only. The vector is the stored BFloat16 value, so a write of it
   * stores the same value.
   */
  readEmbeddings(
    scope: KnowledgeScope,
    docKeys: string[],
    embeddingKeys: string[],
  ): Promise<Map<string, number[]>>
  /**
   * The stored reading of each image blob of `blobShas` by the vision model
   * `model` with the prompt version `promptVersion` (CTX-1433), in the
   * Workspace of `scope` only.
   */
  readImageTexts(
    scope: KnowledgeScope,
    blobShas: string[],
    model: string,
    promptVersion: number,
  ): Promise<Map<string, ImageTextRow>>
  /** Stores the readings `rows` for the Workspace of `scope`. */
  writeImageTexts(scope: KnowledgeScope, rows: ImageTextRow[]): Promise<void>
  /**
   * The key and the status of each document of the view: each tree row, and
   * each relation target with no tree row as `missing` (ADR-071 decision 5).
   */
  listDocumentStatuses(
    scope: KnowledgeReadScope,
  ): Promise<{ docKey: string; status: DocumentStatus }[]>
  /**
   * Each relation target that is a reference key with no document of the
   * view (`ref:<key>`), with each document that states it. Such a key has
   * no row: it is a missing link of its own kind. A `MENTIONS` key and a
   * Linear id key are not in the list: a mention (CTX-1502) or a Linear id
   * (CTX-1716) that names no document is not a broken link.
   */
  listUnresolvedReferences(
    scope: KnowledgeReadScope,
  ): Promise<{ srcDoc: string; dstDoc: string }[]>
  /** The hybrid search of ADR-068 decision 1. */
  search(scope: KnowledgeReadScope, query: SearchQuery): Promise<SearchHit[]>
  /**
   * The out-relations and in-relations of the documents `refs`. With
   * `direction` `out`, only the out-relations.
   */
  readFrontier(
    scope: KnowledgeReadScope,
    refs: DocumentRef[],
    direction?: "out" | "both",
  ): Promise<FrontierRelation[]>
  /**
   * The path of each file of the view whose path starts with `prefix`, with
   * the branch of its tree row: the branch of the read for a row of its
   * overlay, else the default branch. A file read takes the file from Git
   * at the tip of that branch (ADR-071 decision 6).
   */
  listViewFiles(
    scope: KnowledgeReadScope,
    prefix: string,
  ): Promise<{ workspaceId: string; path: string; branch: string }[]>
  /** The document rows of `refs`, with no chunks. */
  readDocuments(
    scope: KnowledgeReadScope,
    refs: DocumentRef[],
  ): Promise<{ workspaceId: string; document: KnowledgeDocument }[]>
  /** The documents `refs` with their chunks closest to `vector`. */
  readEvidence(
    scope: KnowledgeReadScope,
    refs: DocumentRef[],
    vector: number[],
    chunksPerDocument: number,
  ): Promise<Evidence[]>
  /**
   * The documents and relations of the view, at most `limit` of each. A
   * relation to a reference key comes one time for each document of the
   * key, with that document as `dstDoc`. A key with no document keeps the
   * key as `dstDoc`.
   */
  readGraph(scope: KnowledgeReadScope, limit: number): Promise<KnowledgeGraph>
  close(): Promise<void>
}

/**
 * A ClickHouse client for `url`. The client logs to the console, so its log
 * is off: each error goes to the caller instead. The migrations use it too.
 * When `CLICKHOUSE_PASSWORD_FILE` is set, the password of the user in `url`
 * comes from that file: Docker Compose generates it (CTX-1712). It is read
 * from `process.env`, not `parseEnv`, because the migrate job has no app env
 * (`AUTH_SECRET`).
 */
export function createClickHouseClient(url: string): ClickHouseClient {
  const file = process.env.CLICKHOUSE_PASSWORD_FILE?.trim()
  const withPassword = new URL(url)
  if (file)
    withPassword.password = encodeURIComponent(
      readFileSync(file, "utf8").trim(),
    )
  return createClient({
    url: withPassword.toString(),
    application: "ctxpipe-knowledge-store",
    log: { level: ClickHouseLogLevel.OFF },
  })
}

/**
 * Connects to the ClickHouse server at `url` (`CLICKHOUSE_URL`). Throws when
 * the setting is not set.
 */
export function createKnowledgeStore(url: string | undefined): KnowledgeStore {
  if (!url)
    throw new Error(
      "CLICKHOUSE_URL is not set. The knowledge store needs a ClickHouse server (ADR-066).",
    )
  const client = createClickHouseClient(url)
  const counted = (counter?: MutationCounter) => counter ?? { mutations: 0 }
  return {
    findFileVersions: (scope, keys) => findFileVersions(client, scope, keys),
    writeFileVersions: (scope, versions, counter) =>
      writeFileVersions(client, scope, versions, counted(counter)),
    readTree: (scope, head) => readTree(client, scope, head),
    hasTree: async (scope, head) =>
      (
        await select<{ found: number }>(
          client,
          scope,
          `SELECT 1 AS found FROM trees
           WHERE ${scoped} AND branch = {branch:String}
             AND tree_version <= {treeVersion:UInt64}
           LIMIT 1`,
          head,
        )
      ).length > 0,
    writeTree: (scope, branch, treeVersion, entries) =>
      writeTree(client, scope, branch, treeVersion, entries),
    deleteTreeAbove: (scope, branch, treeVersion, counter) =>
      deleteCounted(
        client,
        scope,
        counted(counter),
        "trees",
        "branch = {branch:String} AND tree_version > {treeVersion:UInt64}",
        { branch, treeVersion },
      ),
    cleanUp: (scope, input, counter) =>
      cleanUp(client, scope, input, counted(counter)),
    purge: (scope) => purge(client, scope),
    findPurgedParts: (scope) => findPurgedParts(client, scope),
    erasePurged: (scope) => erasePurged(client, scope),
    purgedRowsInParts: (scope) => purgedRowsInParts(client, scope),
    partsLeft: (parts) => partsLeft(client, parts),
    readEmbeddings: (scope, docKeys, embeddingKeys) =>
      readEmbeddings(client, scope, docKeys, embeddingKeys),
    readImageTexts: (scope, blobShas, model, promptVersion) =>
      readImageTexts(client, scope, blobShas, model, promptVersion),
    writeImageTexts: (scope, rows) => writeImageTexts(client, scope, rows),
    listDocumentStatuses: (scope) => listDocumentStatuses(client, scope),
    listUnresolvedReferences: (scope) =>
      listUnresolvedReferences(client, scope),
    search: (scope, query) => search(client, scope, query),
    readFrontier: (scope, refs, direction) =>
      readFrontier(client, scope, refs, direction),
    readDocuments: (scope, refs) => readDocuments(client, scope, refs),
    listViewFiles: (scope, prefix) =>
      selectIn<{ workspaceId: string; path: string; branch: string }>(
        client,
        scope,
        "view_files",
        `WITH tree_view AS (${treeView})
         SELECT workspace_id AS workspaceId, path, branch FROM tree_view
         WHERE kind = 'file' AND startsWith(path, {prefix:String})
         ORDER BY workspaceId, path`,
        { prefix },
      ),
    readEvidence: (scope, refs, vector, chunksPerDocument) =>
      readEvidence(client, scope, refs, vector, chunksPerDocument),
    readGraph: (scope, limit) => readGraph(client, scope, limit),
    close: () => client.close(),
  }
}

/** The key of a file version in a map or a set. */
export const fileVersionId = (key: FileVersionKey) =>
  `${key.docKey}\0${key.version}`

function assertScope(scope: KnowledgeScope): void {
  if (!scope.orgId || !scope.workspaceId)
    throw new Error("A knowledge statement needs an org and a Workspace")
}

/** The org and Workspace predicates of each statement. */
const scoped = "org_id = {orgId:String} AND workspace_id = {workspaceId:String}"

/** The parameters of `scoped`. They come last: a caller cannot replace them. */
const scopeParams = (
  scope: KnowledgeScope,
  params: Record<string, unknown>,
) => ({
  ...params,
  orgId: scope.orgId,
  workspaceId: scope.workspaceId,
})

/** Runs one read for the Workspace of `scope` (`scoped`), with no tree. */
async function select<T>(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  assertScope(scope)
  const result = await client.query({
    query,
    query_params: scopeParams(scope, params),
    format: "JSONEachRow",
    clickhouse_settings: {
      [ORG_SETTING]: scope.orgId,
      date_time_output_format: "iso",
    },
  })
  return result.json<T>()
}

/**
 * The only builder of a DELETE. It adds the org and Workspace predicates
 * before the predicate `where` of this module, so no statement deletes rows
 * outside the scope. The predicates are constants of this module. Each value
 * comes in as a query parameter.
 *
 * This is the classic lightweight DELETE (the `_row_exists` mask). A DELETE
 * that writes a patch part (`lightweight_delete_mode = 'lightweight_update'`)
 * and the lightweight UPDATE can stay hidden from reads (ADR-066 decision 8).
 */
async function deleteWhere(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  table: keyof TableRows,
  where: string,
  params: Record<string, unknown>,
): Promise<void> {
  assertScope(scope)
  await client.command({
    query: `DELETE FROM ${table} WHERE ${scoped} AND (${where})`,
    query_params: scopeParams(scope, params),
    clickhouse_settings: {
      [ORG_SETTING]: scope.orgId,
      // The DELETE returns after its mutation is done, so the next statement
      // does not see the rows.
      lightweight_deletes_sync: "2",
    },
  })
}

/** {@link deleteWhere}, and 1 more mutation in `counter`. */
async function deleteCounted(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  counter: MutationCounter,
  table: keyof TableRows,
  where: string,
  params: Record<string, unknown>,
): Promise<void> {
  await deleteWhere(client, scope, table, where, params)
  counter.mutations++
}

/**
 * At most this many values go in one IN list. ClickHouse takes the query
 * parameters of a DELETE in the URL, and keeps the URL below
 * `http_max_uri_size` (1 MiB). A longer list goes in more statements.
 */
const IN_LIST_CAP = 1000

const slices = <T>(items: T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / IN_LIST_CAP) }, (_, index) =>
    items.slice(index * IN_LIST_CAP, (index + 1) * IN_LIST_CAP),
  )

/** The value of a `{keys:Array(Tuple(String, String))}` parameter. */
const keyTuples = (keys: FileVersionKey[]) =>
  keys.map((key) => new TupleParam([key.docKey, key.version]))

/**
 * Deletes all rows of the file versions `keys`, with one DELETE for each
 * table and each slice of keys. The document rows go first, so that a stop
 * at any point leaves no document row of a part of a file version: a write
 * sees the version as not stored and deletes the rest first. The chunks go
 * last, so that the rest of a stopped DELETE always has chunks, and the
 * cleanup finds it. `relations_in` goes before `relations`, because its
 * DELETE finds its rows through the targets of `relations` (its sort key).
 */
async function deleteVersions(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  keys: FileVersionKey[],
  counter: MutationCounter,
): Promise<void> {
  const remove = (
    table: keyof TableRows,
    where: string,
    params: Record<string, unknown>,
  ) => deleteCounted(client, scope, counter, table, where, params)
  const inKeys = "(doc_key, version) IN {keys:Array(Tuple(String, String))}"
  const inSources =
    "(src_doc, src_version) IN {keys:Array(Tuple(String, String))}"
  for (const slice of slices(keys)) {
    const params = { keys: keyTuples(slice) }
    const targets = await select<{ dstDoc: string }>(
      client,
      scope,
      `SELECT DISTINCT dst_doc AS dstDoc FROM relations
       WHERE ${scoped} AND ${inSources}`,
      params,
    )
    const refKeys = await select<{ refKey: string }>(
      client,
      scope,
      `SELECT DISTINCT ref_key AS refKey FROM doc_refs
       WHERE ${scoped} AND ${inKeys}`,
      params,
    )
    await remove("documents", inKeys, params)
    for (const dstDocs of slices(targets.map((target) => target.dstDoc)))
      await remove(
        "relations_in",
        `dst_doc IN {dstDocs:Array(String)} AND ${inSources}`,
        { ...params, dstDocs },
      )
    await remove("relations", inSources, params)
    for (const keySlice of slices(refKeys.map((row) => row.refKey)))
      await remove(
        "doc_refs",
        `ref_key IN {refKeys:Array(String)} AND ${inKeys}`,
        { ...params, refKeys: keySlice },
      )
    await remove("chunks", inKeys, params)
  }
}

type StoredVersionRecord = FileVersionKey & {
  status: "active" | "failed"
  kind: string
  observedAt: string
  createdAt: string | null
  updatedAt: string | null
  expiresAt: string | null
}

async function findFileVersions(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  keys: FileVersionKey[],
): Promise<Map<string, StoredFileVersion>> {
  const found = new Map<string, StoredFileVersion>()
  for (const slice of slices(keys))
    for (const row of await select<StoredVersionRecord>(
      client,
      scope,
      `SELECT doc_key AS docKey, version, status, kind,
         observed_at AS observedAt, created_at AS createdAt,
         updated_at AS updatedAt, expires_at AS expiresAt
       FROM documents
       WHERE ${scoped}
         AND (doc_key, version) IN {keys:Array(Tuple(String, String))}`,
      { keys: keyTuples(slice) },
    ))
      found.set(fileVersionId(row), {
        status: row.status,
        kind: row.kind,
        observedAt: new Date(row.observedAt),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
        expiresAt: toDate(row.expiresAt),
      })
  return found
}

async function writeFileVersions(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  versions: FileVersionRows[],
  counter: MutationCounter,
): Promise<void> {
  assertScope(scope)
  if (versions.length === 0) return
  const ids = versions.map((rows) =>
    fileVersionId({ docKey: rows.document.docKey, version: rows.version }),
  )
  if (new Set(ids).size !== ids.length)
    throw new Error("A write has the same file version two times")
  // A write inserts the chunks first and the document row last, and each
  // active file version has a chunk. Thus the rest of a stopped write has
  // chunks.
  const leftovers: FileVersionKey[] = []
  for (const slice of slices(
    versions.map((rows) => ({
      docKey: rows.document.docKey,
      version: rows.version,
    })),
  ))
    leftovers.push(
      ...(await select<FileVersionKey>(
        client,
        scope,
        `SELECT DISTINCT doc_key AS docKey, version FROM chunks
         WHERE ${scoped}
           AND (doc_key, version) IN {keys:Array(Tuple(String, String))}`,
        { keys: keyTuples(slice) },
      )),
    )
  if (leftovers.length > 0)
    await deleteVersions(client, scope, leftovers, counter)
  await insertRows(client, scope, versions)
}

/** The columns of each table, as an insert sends them. */
type ScopeColumns = { org_id: string; workspace_id: string }
type RelationColumns = ScopeColumns & {
  src_doc: string
  src_version: string
  src_chunk: number
  predicate: string
  dst_doc: string
  confidence: number
  valid_from: string | null
  valid_from_introduced: boolean
  valid_to: string | null
  source: string
  alt_text: string
  observed_at: string
}
type TableRows = {
  documents: ScopeColumns & {
    doc_key: string
    version: string
    kind: string
    status: "active" | "failed"
    error: string
    title: string
    path: string
    source_type: string
    source: string
    summary: string
    mime: string
    created_at: string | null
    updated_at: string | null
    expires_at: string | null
    observed_at: string
  }
  chunks: ScopeColumns & {
    doc_key: string
    version: string
    ordinal: number
    text: string
    start_line: number
    end_line: number
    embedding: number[]
    embedding_key: string
  }
  relations: RelationColumns
  relations_in: RelationColumns
  doc_refs: ScopeColumns & { ref_key: string; doc_key: string; version: string }
  trees: ScopeColumns & {
    branch: string
    doc_key: string
    tree_version: number
    kind: "file" | "deleted" | "inherit"
    path: string
    version: string
    status: "active" | "failed"
    doc_kind: string
    observed_at: string
    created_at: string | null
    updated_at: string | null
    expires_at: string | null
    deleted_at: string | null
  }
}

/**
 * Inserts `values` into `table`. The insert wall of this module: each row is
 * made field by field from the scope and the typed input, so a value that a
 * caller puts in a row does not get into the insert.
 */
async function insert<T extends keyof TableRows>(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  table: T,
  values: TableRows[T][],
): Promise<void> {
  if (values.length === 0) return
  await client.insert({
    table,
    values,
    format: "JSONEachRow",
    clickhouse_settings: {
      [ORG_SETTING]: scope.orgId,
      // With 0, an async insert that the server refuses fails silently.
      wait_for_async_insert: 1,
      date_time_input_format: "best_effort",
    },
  })
}

const isoOrNull = (time: Date | null) => time?.toISOString() ?? null

async function insertRows(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  versions: FileVersionRows[],
): Promise<void> {
  const owner: ScopeColumns = {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
  }
  await insert(
    client,
    scope,
    "chunks",
    versions.flatMap(({ document, version, chunks }) =>
      chunks.map((chunk) => ({
        ...owner,
        doc_key: document.docKey,
        version,
        ordinal: chunk.ordinal,
        text: chunk.text,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        embedding: chunk.embedding,
        embedding_key: chunk.embeddingKey ?? "",
      })),
    ),
  )
  const relations = versions.flatMap(({ document, version, relations }) =>
    relations.map((relation) => ({
      ...owner,
      src_doc: document.docKey,
      src_version: version,
      src_chunk: relation.srcChunk,
      predicate: relation.predicate,
      dst_doc: relation.dstDoc,
      confidence: relation.confidence,
      valid_from: isoOrNull(relation.validFrom),
      valid_from_introduced: relation.validFromIntroduced,
      valid_to: isoOrNull(relation.validTo),
      source: relation.source,
      alt_text: relation.altText,
      observed_at: relation.observedAt.toISOString(),
    })),
  )
  // relations first: deleteVersions finds the rows of relations_in through
  // relations.
  await insert(client, scope, "relations", relations)
  await insert(client, scope, "relations_in", relations)
  await insert(
    client,
    scope,
    "doc_refs",
    versions.flatMap(({ document, version, refKeys = [] }) =>
      [...new Set(refKeys)].map((refKey) => ({
        ...owner,
        ref_key: refKey,
        doc_key: document.docKey,
        version,
      })),
    ),
  )
  // The document row last: it says that the file version is stored.
  await insert(
    client,
    scope,
    "documents",
    versions.map(({ document, version, error }) => ({
      ...owner,
      doc_key: document.docKey,
      version,
      kind: document.kind,
      status: error === undefined ? ("active" as const) : ("failed" as const),
      error: error ?? "",
      title: document.title,
      path: document.path,
      source_type: document.sourceType,
      source: document.source,
      summary: document.summary,
      mime: document.mime,
      created_at: isoOrNull(document.createdAt),
      updated_at: isoOrNull(document.updatedAt),
      expires_at: isoOrNull(document.expiresAt),
      observed_at: document.observedAt.toISOString(),
    })),
  )
}

async function writeTree(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  branch: string,
  treeVersion: number,
  entries: TreeEntry[],
): Promise<void> {
  assertScope(scope)
  if (!branch) throw new Error("A tree row needs a branch")
  await insert(
    client,
    scope,
    "trees",
    entries.map((entry) => ({
      org_id: scope.orgId,
      workspace_id: scope.workspaceId,
      branch,
      doc_key: entry.docKey,
      tree_version: treeVersion,
      kind: entry.inherit
        ? ("inherit" as const)
        : entry.deletedAt
          ? ("deleted" as const)
          : ("file" as const),
      path: entry.path,
      version: entry.version,
      status: entry.status,
      doc_kind: entry.kind,
      observed_at: entry.observedAt.toISOString(),
      created_at: isoOrNull(entry.createdAt),
      updated_at: isoOrNull(entry.updatedAt),
      expires_at: isoOrNull(entry.expiresAt),
      deleted_at: isoOrNull(entry.deletedAt),
    })),
  )
}

type TreeRecord = FileVersionKey & {
  path: string
  inherit: boolean
  status: "active" | "failed"
  kind: string
  observedAt: string
  createdAt: string | null
  updatedAt: string | null
  expiresAt: string | null
  deletedAt: string | null
}

async function readTree(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  head: TreeHead,
): Promise<TreeEntry[]> {
  assertScope(scope)
  const rows = await selectIn<TreeRecord>(
    client,
    {
      orgId: scope.orgId,
      heads: [{ workspaceId: scope.workspaceId, ...head }],
    },
    "tree",
    // The rows of the tree itself, with its `inherit` rows: no view.
    `SELECT doc_key AS docKey, version, path, status,
       doc_kind AS kind, observed_at AS observedAt, created_at AS createdAt,
       updated_at AS updatedAt, expires_at AS expiresAt,
       deleted_at AS deletedAt,
       kind = 'inherit' AS inherit
     FROM (${newestRows("treeBranches", "treeVersions")}) ORDER BY docKey`,
    {},
  )
  return rows.map((row) => ({
    ...row,
    observedAt: new Date(row.observedAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    expiresAt: toDate(row.expiresAt),
    deletedAt: toDate(row.deletedAt),
  }))
}

async function cleanUp(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  input: { heads: TreeHead[]; replacedBefore: Date; unusedBefore: Date },
  counter: MutationCounter,
): Promise<CleanupCounts> {
  assertScope(scope)
  const counts: CleanupCounts = { treeRows: 0, fileVersions: 0 }
  const remove = (
    table: keyof TableRows,
    where: string,
    params: Record<string, unknown>,
  ) => deleteCounted(client, scope, counter, table, where, params)
  const replacedBefore = clickHouseTime(input.replacedBefore)
  const branches = input.heads.map((head) => head.branch)
  // The branches with no head, for example the earlier name of a renamed
  // default branch. A head left such a branch when it moved to a tree of a
  // branch of `heads`, and each row of that tree was written at that time
  // or later. Thus when the oldest row of the trees of `heads` is older
  // than the grace time, no read can still use a head of these branches.
  const orphans = await select<{ branch: string; rows: string }>(
    client,
    scope,
    `SELECT branch, count() AS rows FROM trees
     WHERE ${scoped} AND branch NOT IN {branches:Array(String)}
       AND (SELECT min(written_at) FROM trees
            WHERE ${scoped} AND branch IN {branches:Array(String)})
         < {replacedBefore:DateTime64(3, 'UTC')}
     GROUP BY branch`,
    { branches, replacedBefore },
  )
  for (const slice of slices(orphans)) {
    await remove("trees", "branch IN {orphans:Array(String)}", {
      orphans: slice.map((row) => row.branch),
    })
    for (const { rows } of slice) counts.treeRows += Number(rows)
  }
  for (const head of input.heads) {
    const replaced = await select<{ docKey: string; treeVersion: string }>(
      client,
      scope,
      `SELECT t.doc_key AS docKey, t.tree_version AS treeVersion
       FROM trees AS t
       INNER JOIN (
         SELECT doc_key, max(tree_version) AS newest,
           argMax(written_at, tree_version) AS newest_written
         FROM trees
         WHERE ${scoped} AND branch = {branch:String}
           AND tree_version <= {treeVersion:UInt64}
         GROUP BY doc_key
       ) AS latest ON latest.doc_key = t.doc_key
       WHERE t.org_id = {orgId:String} AND t.workspace_id = {workspaceId:String}
         AND t.branch = {branch:String} AND t.tree_version < latest.newest
         AND latest.newest_written < {replacedBefore:DateTime64(3, 'UTC')}`,
      { ...head, replacedBefore },
    )
    for (const slice of slices(replaced)) {
      await remove(
        "trees",
        "branch = {branch:String} AND (doc_key, tree_version) IN {rows:Array(Tuple(String, UInt64))}",
        {
          branch: head.branch,
          rows: slice.map(
            (row) => new TupleParam([row.docKey, Number(row.treeVersion)]),
          ),
        },
      )
      counts.treeRows += slice.length
    }
  }
  // A file version that no tree row uses. The chunks give the rest of a
  // stopped write or DELETE, which has no document row.
  const unused = await select<FileVersionKey>(
    client,
    scope,
    `SELECT doc_key AS docKey, version FROM (
       SELECT doc_key, version, written_at FROM documents WHERE ${scoped}
       UNION ALL
       SELECT doc_key, version, written_at FROM chunks WHERE ${scoped}
     )
     GROUP BY doc_key, version
     HAVING max(written_at) < {unusedBefore:DateTime64(3, 'UTC')}
       AND (doc_key, version) NOT IN (
         SELECT doc_key, version FROM trees WHERE ${scoped})`,
    { unusedBefore: clickHouseTime(input.unusedBefore) },
  )
  await deleteVersions(client, scope, unused, counter)
  counts.fileVersions = unused.length
  return counts
}

/**
 * The purge of {@link KnowledgeStore.purge}. It builds its own DELETEs,
 * because a purge of an org has no Workspace predicate. The org predicate is
 * always there, and the Workspace predicate is there when the scope has a
 * Workspace. Each value comes in as a query parameter. Each DELETE is the
 * classic lightweight DELETE, as in {@link deleteWhere}.
 */
async function purge(
  client: ClickHouseClient,
  scope: PurgeScope,
): Promise<PurgeCounts> {
  const [where, params] = purgeWhere(scope)
  const settings = { [ORG_SETTING]: scope.orgId }
  const counts = { ...NO_KNOWLEDGE_ROWS }
  for (const table of KNOWLEDGE_TABLES) {
    // The count goes to the log. A table with no row of the scope gets no
    // DELETE, so a purge of a scope with no rows makes no mutation.
    const result = await client.query({
      query: `SELECT count() AS rows FROM ${table} WHERE ${where}`,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: settings,
    })
    const [row] = await result.json<{ rows: string }>()
    counts[table] = Number(row?.rows ?? 0)
    if (counts[table] === 0) continue
    await client.command({
      query: `DELETE FROM ${table} WHERE ${where}`,
      query_params: params,
      clickhouse_settings: { ...settings, lightweight_deletes_sync: "2" },
    })
  }
  return counts
}

/**
 * The WHERE clause and its parameters of a purge: the org predicate, and
 * the Workspace predicate when the scope has a Workspace.
 */
function purgeWhere(
  scope: PurgeScope,
): [string, { orgId: string; workspaceId?: string }] {
  if (!scope.orgId) throw new Error("A knowledge purge needs an org")
  if (scope.workspaceId !== null && !scope.workspaceId)
    throw new Error("A knowledge purge of a Workspace needs a Workspace id")
  return scope.workspaceId === null
    ? ["org_id = {orgId:String}", { orgId: scope.orgId }]
    : [
        "org_id = {orgId:String} AND workspace_id = {workspaceId:String}",
        { orgId: scope.orgId, workspaceId: scope.workspaceId },
      ]
}

/**
 * The active parts of `table` that hold rows of `scope`, also rows that a
 * DELETE hid (`apply_deleted_mask = 0`), with their partition and the count
 * of those rows.
 */
async function purgedParts(
  client: ClickHouseClient,
  table: (typeof KNOWLEDGE_TABLES)[number],
  scope: PurgeScope,
): Promise<{ partition: string; part: string; rows: number }[]> {
  const [where, params] = purgeWhere(scope)
  const result = await client.query({
    query: `SELECT _partition_id AS partition, _part AS part, count() AS rows
            FROM ${table} WHERE ${where} GROUP BY partition, part`,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: { [ORG_SETTING]: scope.orgId, apply_deleted_mask: 0 },
  })
  return (
    await result.json<{ partition: string; part: string; rows: string }>()
  ).map((row) => ({ ...row, rows: Number(row.rows) }))
}

/** The parts of {@link KnowledgeStore.findPurgedParts}. */
async function findPurgedParts(
  client: ClickHouseClient,
  scope: PurgeScope,
): Promise<PurgedPart[]> {
  const found: PurgedPart[] = []
  for (const table of KNOWLEDGE_TABLES)
    for (const { part } of await purgedParts(client, table, scope))
      found.push({ table, part })
  return found
}

/**
 * The erase of {@link KnowledgeStore.erasePurged}. `APPLY DELETED MASK`
 * removes only the rows that a DELETE hid, so it cannot remove a visible
 * row of another scope. A partition with rows of the scope can also hold
 * rows that the projection deleted: the mutation removes those too. A part
 * keeps its volume: a cold part is read from the bucket and written to it
 * again (ADR-066 decision 9).
 */
async function erasePurged(
  client: ClickHouseClient,
  scope: PurgeScope,
): Promise<number> {
  let mutations = 0
  for (const table of KNOWLEDGE_TABLES) {
    const parts = await purgedParts(client, table, scope)
    for (const partition of new Set(parts.map((part) => part.partition))) {
      // The id of a partition by toYYYYMM is digits only, and a table with
      // no partition key (image_texts) has the one partition `all`. The
      // statement takes no query parameter at this place.
      if (!/^(\d+|all)$/.test(partition))
        throw new Error(`Unexpected partition id of ${table}`)
      await client.command({
        query: `ALTER TABLE ${table} APPLY DELETED MASK IN PARTITION ID '${partition}'`,
        // The mutation runs in the background. A rewrite of a large cold
        // part can take longer than one HTTP request.
        clickhouse_settings: { mutations_sync: "0" },
      })
      mutations += 1
    }
  }
  return mutations
}

/** The count of {@link KnowledgeStore.purgedRowsInParts}. */
async function purgedRowsInParts(
  client: ClickHouseClient,
  scope: PurgeScope,
): Promise<number> {
  let rows = 0
  for (const table of KNOWLEDGE_TABLES)
    for (const part of await purgedParts(client, table, scope))
      rows += part.rows
  return rows
}

/**
 * The count of {@link KnowledgeStore.partsLeft}. system.parts also lists
 * the replaced parts until ClickHouse removes them from the disk. The
 * writer can read only the database, table and name columns of it.
 */
async function partsLeft(
  client: ClickHouseClient,
  parts: PurgedPart[],
): Promise<number> {
  if (parts.length === 0) return 0
  const result = await client.query({
    query: `SELECT count() AS parts FROM system.parts
            WHERE database = currentDatabase()
              AND concat(table, '/', name) IN {parts:Array(String)}`,
    // A table name has no slash, so table/part names one part.
    query_params: {
      parts: parts.map(({ table, part }) => `${table}/${part}`),
    },
    format: "JSONEachRow",
  })
  const [row] = await result.json<{ parts: string }>()
  return Number(row?.parts ?? 0)
}

/**
 * The chunk sort key starts with `doc_key`, so the filter by `docKeys` reads
 * only the granules of those documents. Each IN list has at most
 * {@link IN_LIST_CAP} values.
 */
async function readEmbeddings(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKeys: string[],
  embeddingKeys: string[],
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>()
  const wanted = [...new Set(embeddingKeys)].filter(Boolean)
  for (const docSlice of slices([...new Set(docKeys)]))
    for (const keySlice of slices(wanted.filter((key) => !vectors.has(key))))
      for (const row of await select<{ key: string; embedding: number[] }>(
        client,
        scope,
        `SELECT embedding_key AS key, any(embedding) AS embedding FROM chunks
         WHERE ${scoped} AND doc_key IN {docKeys:Array(String)}
           AND embedding_key IN {embeddingKeys:Array(String)}
         GROUP BY embedding_key`,
        { docKeys: docSlice, embeddingKeys: keySlice },
      ))
        vectors.set(row.key, row.embedding)
  return vectors
}

async function readImageTexts(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  blobShas: string[],
  model: string,
  promptVersion: number,
): Promise<Map<string, ImageTextRow>> {
  const found = new Map<string, ImageTextRow>()
  for (const slice of slices([...new Set(blobShas)].filter(Boolean)))
    for (const row of await select<ImageTextRow>(
      client,
      scope,
      // FINAL keeps one row of a key that was written twice.
      `SELECT blob_sha AS blobSha, model, prompt_version AS promptVersion,
              reading
       FROM image_texts FINAL
       WHERE ${scoped} AND blob_sha IN {blobShas:Array(String)}
         AND model = {model:String}
         AND prompt_version = {promptVersion:UInt32}`,
      { blobShas: slice, model, promptVersion },
    ))
      found.set(row.blobSha, row)
  return found
}

async function writeImageTexts(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  rows: ImageTextRow[],
): Promise<void> {
  assertScope(scope)
  if (rows.length === 0) return
  // As in insert: each row is made field by field, and the org and
  // Workspace columns come only from the scope.
  await client.insert({
    table: "image_texts",
    values: rows.map((row) => ({
      org_id: scope.orgId,
      workspace_id: scope.workspaceId,
      blob_sha: row.blobSha,
      model: row.model,
      prompt_version: row.promptVersion,
      reading: row.reading,
    })),
    format: "JSONEachRow",
    clickhouse_settings: {
      [ORG_SETTING]: scope.orgId,
      wait_for_async_insert: 1,
    },
  })
}

// ---------------------------------------------------------------------------
// Reads of the view (ADR-068, ADR-071). A read can span several Workspaces of
// one org. Each one goes through `selectIn`, which sets the org of the row
// policy, and each WHERE clause has `org_id` and `workspace_id`. Values go in
// `query_params` only, never into the SQL text.

/**
 * Runs one read for the heads of `scope`. The org, the Workspaces and the
 * heads come last in the parameters, so that the WHERE clause, the tree view
 * and the row policy use the same org.
 */
async function selectIn<T>(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  /** The name of the statement in its span, for example `search.vector`. */
  statement: string,
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  assertReadScope(scope)
  // A span only inside a request or a job (CTX-1688). The span has no SQL
  // text and no parameter: a parameter can be customer content.
  if (!trace.getActiveSpan())
    return runSelectIn<T>(client, scope, query, params)
  return trace.getTracer("ctxpipe-knowledge-store").startActiveSpan(
    `clickhouse ${statement}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system.name": "clickhouse",
        "db.operation.name": "SELECT",
        "db.query.summary": statement,
      },
    },
    async (span) => {
      try {
        const rows = await runSelectIn<T>(client, scope, query, params)
        span.setAttribute("db.response.returned_rows", rows.length)
        return rows
      } catch (error) {
        // The code only: the message can quote a parameter.
        const type =
          error instanceof ClickHouseError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown"
        span.setAttribute("error.type", type)
        span.setStatus({ code: SpanStatusCode.ERROR, message: type })
        throw error
      } finally {
        span.end()
      }
    },
  )
}

async function runSelectIn<T>(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  try {
    const result = await client.query({
      query,
      query_params: {
        // No hidden copies, unless the read gives them (`copyParams`).
        hiddenKeys: [],
        shownKeys: [],
        ...params,
        foldCase: foldsCase(scope),
        orgId: scope.orgId,
        workspaceIds: scope.heads.map((head) => head.workspaceId),
        // The full tree of each Workspace: the base of an overlay, else the
        // tree of the branch itself.
        treeBranches: scope.heads.map(
          (head) =>
            new TupleParam([head.workspaceId, (head.base ?? head).branch]),
        ),
        treeVersions: new Map(
          scope.heads.map((head) => [
            head.workspaceId,
            (head.base ?? head).treeVersion,
          ]),
        ),
        overlayBranches: scope.heads.flatMap((head) =>
          head.base ? [new TupleParam([head.workspaceId, head.branch])] : [],
        ),
        overlayVersions: new Map(
          scope.heads.flatMap((head) =>
            head.base ? [[head.workspaceId, head.treeVersion] as const] : [],
          ),
        ),
      },
      format: "JSONEachRow",
      clickhouse_settings: {
        [ORG_SETTING]: scope.orgId,
        date_time_output_format: "iso",
        // tuple(x AS name, …) gives a JSON object with these names.
        enable_named_columns_in_function_tuple: 1,
      },
    })
    return await result.json<T>()
  } catch (error) {
    throw asClickHouseError(error)
  }
}

/**
 * An error of the ClickHouse server that the client cannot parse, as a
 * `ClickHouseError` with its code. Such an error has no `DB::Exception`,
 * for example when the HTTP handler refuses the request before the query
 * runs ("Poco::Exception. Code: 1000, …"). Then the shadow log and the span
 * give its code (CTX-1688).
 */
function asClickHouseError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof ClickHouseError)
    return error
  const code = /^(?:Poco::Exception\. )?Code: (\d+)\b/.exec(error.message)?.[1]
  return code ? new ClickHouseError({ message: error.message, code }) : error
}

function assertReadScope(scope: KnowledgeReadScope): void {
  const workspaceIds = scope.heads.map((head) => head.workspaceId)
  if (
    !scope.orgId ||
    workspaceIds.length === 0 ||
    scope.heads.some(
      (head) =>
        !head.workspaceId ||
        !head.branch ||
        (head.base && (!head.base.branch || head.base.branch === head.branch)),
    ) ||
    new Set(workspaceIds).size !== workspaceIds.length
  )
    throw new Error(
      "A knowledge read needs an org and one head for each of its Workspaces",
    )
}

const inWorkspaces =
  "org_id = {orgId:String} AND workspace_id IN {workspaceIds:Array(String)}"

/** The columns of a row of the tree view. */
const treeColumns = `workspace_id, branch, doc_key, kind, path, version,
  status, doc_kind, observed_at, created_at, updated_at, expires_at,
  deleted_at`

/**
 * The newest tree row of each document key of the branches `branches` at
 * or below the tree versions `versions` (two parameter names). A row above
 * the head is the row of a run that did not complete, so no read sees it.
 * `LIMIT 1 BY` follows the sort key of the table: it cost 12 ms on 100k
 * paths, `argMax` with `GROUP BY` 60 ms.
 */
const newestRows = (branches: string, versions: string) =>
  `SELECT ${treeColumns} FROM trees
   WHERE ${inWorkspaces}
     AND (workspace_id, branch) IN {${branches}:Array(Tuple(String, String))}
     AND tree_version <= {${versions}:Map(String, UInt64)}[workspace_id]
   ORDER BY workspace_id, doc_key, tree_version DESC
   LIMIT 1 BY workspace_id, doc_key`

/**
 * The tree rows of the heads of a read, one for each path (ADR-071
 * decisions 4 and 5), before the case fold of {@link treeView}. The
 * view of the default branch is its tree. The view of another branch B is
 * the view of the default branch, minus each path of the overlay of B, plus
 * the overlay rows of B: an overlay row wins (layer 1), and an `inherit`
 * row leaves the overlay, so the row of the default branch shows (layer 2).
 * A tombstone of the overlay is a row of the view, so it removes the path.
 * A read with no overlay has no layer 1. A full tree can keep an `inherit`
 * row from the time when it was an overlay (a branch that became the
 * default branch): its path is not in the tree, so the view drops it too.
 */
const treePaths = `SELECT ${treeColumns} FROM (
    SELECT ${treeColumns}, 1 AS layer FROM (
      ${newestRows("overlayBranches", "overlayVersions")}
    ) WHERE kind != 'inherit'
    UNION ALL
    SELECT ${treeColumns}, 2 AS layer FROM (
      ${newestRows("treeBranches", "treeVersions")}
    ) WHERE kind != 'inherit'
  )
  ORDER BY workspace_id, doc_key, layer
  LIMIT 1 BY workspace_id, doc_key`

/** The folded form of `path`: NFC, then lowercase (`foldPath`). */
const foldedPath = "lowerUTF8(normalizeUTF8NFC(path))"

/**
 * The order of the rows of one folded path, the row that the view shows
 * first (CTX-1697): a file before a tombstone, then the order of
 * `compareCopies` in `domain/workspaces/case-duplicates.ts`: the newest
 * `updated_at` (the time that an agent sees, CTX-1710: the time that the
 * file states, else the last commit that changed the path), then the
 * canonical path, then the byte order.
 */
const caseOrder = `kind != 'file', updated_at DESC NULLS LAST,
  path != ${foldedPath}, path`

/**
 * The tree view of the heads of a read (ADR-071 decision 5): the rows of
 * {@link treePaths}, with one row for each path that is equal after case
 * folding when the parameter `foldCase` is true (CTX-1697). Git can hold
 * two such paths, and they are one file on a checkout that ignores case.
 * With `foldCase` false, each path keeps its row. The fold sorts the whole
 * view (25 ms on 100k paths), so a read folds only when a head can show a
 * case duplicate ({@link foldsCase}).
 *
 * This is the one place of the tree rule. Each read of the view starts with
 * `WITH tree_view AS (${treeView})`.
 */
const treeView = `SELECT ${treeColumns} FROM (${treePaths})
  ORDER BY workspace_id, if({foldCase:Bool}, ${foldedPath}, doc_key),
    ${caseOrder}
  LIMIT 1 BY workspace_id, if({foldCase:Bool}, ${foldedPath}, doc_key)`

/**
 * True when the view of a head can hold two rows whose paths are equal
 * after case folding: the tree of a default branch has such rows (also a
 * tombstone, which a link can name), or their count is not known. The
 * view of an overlay holds the newer files of the default branch beside the
 * rows of the branch, so no count of one tree shows them: it always folds.
 */
const foldsCase = (scope: KnowledgeReadScope) =>
  scope.heads.some((head) => head.base || head.caseDuplicateRows !== 0)

/**
 * The document key of each path that the view hides because it shows
 * another path that is equal after case folding, to the document key that
 * it shows (CTX-1697). A document key holds its Workspace, so one map
 * serves a read of many Workspaces. Empty when the read does not fold.
 */
type HiddenCopies = ReadonlyMap<string, string>

async function readHiddenCopies(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
): Promise<HiddenCopies> {
  if (!foldsCase(scope)) return new Map()
  const rows = await selectIn<{ hidden: string; shown: string }>(
    client,
    scope,
    "hidden_copies",
    `SELECT doc_key AS hidden, shown FROM (
       SELECT doc_key, first_value(doc_key) OVER (
         PARTITION BY workspace_id, ${foldedPath} ORDER BY ${caseOrder}
       ) AS shown
       FROM (${treePaths})
     ) WHERE doc_key != shown`,
    {},
  )
  return new Map(rows.map((row) => [row.hidden, row.shown]))
}

/**
 * The query parameters of {@link relationsOf} for `copies`: a relation to
 * a hidden copy goes to the copy that the view shows.
 */
const copyParams = (copies: HiddenCopies) => ({
  hiddenKeys: [...copies.keys()],
  shownKeys: [...copies.values()],
})

/** `refs` with each hidden copy as the copy that the view shows, one time each. */
function shownRefs(refs: DocumentRef[], copies: HiddenCopies): DocumentRef[] {
  if (copies.size === 0) return refs
  const shown = new Map<string, DocumentRef>()
  for (const ref of refs) {
    const docKey = copies.get(ref.docKey) ?? ref.docKey
    shown.set(documentId({ ...ref, docKey }), { ...ref, docKey })
  }
  return [...shown.values()]
}

/**
 * The refs of {@link shownRefs}, then the hidden copies of each of them, so
 * that a query also finds the in-relations to a hidden copy.
 */
function shownRefsAndCopies(
  refs: DocumentRef[],
  copies: HiddenCopies,
): DocumentRef[] {
  const shown = shownRefs(refs, copies)
  const byKey = new Map(shown.map((ref) => [ref.docKey, ref]))
  const hidden = [...copies].flatMap(([docKey, shownKey]) => {
    const ref = byKey.get(shownKey)
    return ref ? [{ ...ref, docKey }] : []
  })
  return [...shown, ...hidden]
}

/** The tree rows of the view that hold a file version (not a tombstone). */
const viewFiles = `SELECT workspace_id, doc_key, version, created_at
  FROM tree_view WHERE kind = 'file'`

/**
 * The FROM clause of the documents of the tree rows that pass `filter` (a
 * condition on the columns of `tree_view`): each row `v` with the fields of
 * its file version `d`. The columns of {@link viewDocumentColumns} read it.
 */
const viewDocumentsFrom = (filter: string) => `
  (SELECT * FROM tree_view WHERE ${filter}) AS v
  LEFT JOIN (
    SELECT workspace_id, doc_key, version, error, title, source_type, source,
      summary, mime
    FROM documents
    WHERE ${inWorkspaces} AND (workspace_id, doc_key, version) IN (
      SELECT workspace_id, doc_key, version FROM tree_view WHERE ${filter})
  ) AS d
    ON d.workspace_id = v.workspace_id AND d.doc_key = v.doc_key
    AND d.version = v.version`

/**
 * The fields of a {@link KnowledgeDocument} from `v` and `d` of
 * {@link viewDocumentsFrom}. A tombstone is `deleted` with no error.
 */
const viewDocumentColumns = `v.doc_key AS docKey, v.doc_kind AS kind,
  if(v.kind = 'deleted', 'deleted', toString(v.status)) AS status,
  v.deleted_at AS deletedAt, if(v.kind = 'deleted', '', d.error) AS error,
  d.title AS title, v.path AS path, d.source_type AS sourceType,
  d.source AS source, d.summary AS summary, d.mime AS mime,
  v.created_at AS createdAt, v.updated_at AS updatedAt,
  v.expires_at AS expiresAt, v.observed_at AS observedAt`

/** The target of the relation `r`, as the copy that the view shows. */
const shownTarget = `transform(r.dst_doc, {hiddenKeys:Array(String)},
  {shownKeys:Array(String)}, r.dst_doc)`

/**
 * The relations of the file versions of `sources` (a subquery with the
 * columns of {@link viewFiles}), with the columns of a relation. A relation
 * with `valid_from_introduced` takes as its `valid_from` the `created_at`
 * of its source row: the claim holds from the time that the document began.
 *
 * A relation to a hidden copy (the parameters of {@link copyParams}) goes
 * to the copy that the view shows, and a relation of a document to its own
 * hidden copy is not returned (CTX-1697). The conditions that a caller adds
 * on `r.dst_doc` see the stored target.
 */
const relationsOf = (table: "relations" | "relations_in", sources: string) =>
  `SELECT r.workspace_id AS workspace_id, r.src_doc AS src_doc,
     r.src_chunk AS src_chunk, r.predicate AS predicate,
     ${shownTarget} AS dst_doc,
     r.confidence AS confidence,
     if(r.valid_from_introduced, s.created_at, r.valid_from) AS valid_from,
     r.valid_to AS valid_to, r.source AS source, r.alt_text AS alt_text,
     r.observed_at AS observed_at
   FROM ${table} AS r
   INNER JOIN (${sources}) AS s
     ON s.workspace_id = r.workspace_id AND s.doc_key = r.src_doc
     AND s.version = r.src_version
   WHERE r.org_id = {orgId:String}
     AND r.workspace_id IN {workspaceIds:Array(String)}
     AND NOT (has({hiddenKeys:Array(String)}, r.dst_doc)
       AND ${shownTarget} = r.src_doc)`

/** A time in the text form of a `DateTime64(3, 'UTC')` parameter. */
const clickHouseTime = (time: Date) =>
  time.toISOString().slice(0, 23).replace("T", " ")

/** The binary form of a vector, as hex: the same bits as `embedding_bits`. */
function vectorBits(vector: number[]): string {
  const bytes = new Uint8Array(Math.ceil(vector.length / 8))
  vector.forEach((value, index) => {
    if (value > 0)
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (0x80 >> (index & 7))
  })
  return Buffer.from(bytes).toString("hex")
}

type ChunkKey = {
  workspaceId: string
  docKey: string
  version: string
  ordinal: number
}
const chunkId = (key: ChunkKey) =>
  JSON.stringify([key.workspaceId, key.docKey, key.version, key.ordinal])
/** The key of a document of a read: its Workspace and its document key. */
export const documentId = (ref: DocumentRef) =>
  JSON.stringify([ref.workspaceId, ref.docKey])
/** The value of a `{refs:Array(Tuple(String, String))}` parameter. */
const refTuples = (refs: DocumentRef[]) =>
  refs.map((ref) => new TupleParam([ref.workspaceId, ref.docKey]))

/**
 * The hybrid search of ADR-068 decision 1, on the active file versions of
 * the view:
 * 1. Vector: a Hamming scan of `embedding_bits` keeps the top 500, then the
 *    cosine distance on `embedding` orders them. Both stages are one query,
 *    so ClickHouse reads `embedding` for the 500 rows only (lazy
 *    materialization; `chunks` has `index_granularity = 64`).
 * 2. Lexical: one `hasToken` filter for each term selects at most 1000
 *    chunks through the text index. The score of a chunk is the sum of the
 *    IDF weights of its matched terms, plus 4 times the weights of the
 *    terms in the title of its document. The IDF of a term is the BM25
 *    IDF from the count of the chunks of the Workspaces that have it, so
 *    a common word such as
 *    "a" weighs almost nothing. The text index gives each count without a
 *    read of the text column. A function on `text` in the SELECT list would
 *    read the full text column. The lexical query does not need the query
 *    vector, so it starts before the vector is ready (`vector` can be a
 *    promise).
 * 3. RRF (k = 60) fuses the two orders, with a lower weight for a lexical
 *    chunk that has only a small share of the query terms. The fused
 *    chunks are grouped by document, a document in the order of its best
 *    chunk, and the top 50 documents are the hits. Thus a long document
 *    takes one place, not one place for each of its chunks (CTX-1455).
 * 4. With `neighbors`, the neighbors of the best hits take the last places
 *    (`searchNeighbors`). Their read runs at the same time as the read of
 *    the documents and the texts of the hits.
 * The filters use the copies on the tree rows, so the search does not join
 * the documents table before the cut.
 */
async function search(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  {
    vector,
    terms,
    kinds = [],
    pathPrefix = "",
    sources = [],
    updatedAfter = null,
    chunksPerDocument,
    neighbors,
  }: SearchQuery,
): Promise<SearchHit[]> {
  // hasToken refuses a term with a separator in it. Split each term as the
  // splitByNonAlpha tokenizer of the text index does: at each ASCII character
  // that is not a letter or a digit.
  const uniqueTerms = [
    ...new Set(
      terms
        .flatMap((term) => term.split(/[^A-Za-z0-9\P{ASCII}]+/u))
        .filter(Boolean),
    ),
  ]
  // The parameters of `searchable`.
  const filters = {
    kinds,
    pathPrefix,
    sources,
    mirrorRoots: CONNECTOR_MIRROR_ROOTS,
    updatedAfter: updatedAfter && clickHouseTime(updatedAfter),
  }
  const params = {
    ...filters,
    ...Object.fromEntries(uniqueTerms.map((term, i) => [`term${i}`, term])),
  }
  // The tree rows that the search can find: active, and in the filters.
  const searchable = `kind = 'file' AND status = 'active'
    AND (empty({kinds:Array(String)}) OR has({kinds:Array(String)}, doc_kind))
    AND startsWith(path, {pathPrefix:String})
    AND (empty({sources:Array(String)}) OR has({sources:Array(String)},
      ifNull(arrayFirst(root -> path = root OR startsWith(path, concat(root, '/')),
        {mirrorRoots:Array(Nullable(String))}), 'authored')))
    AND ({updatedAfter:Nullable(DateTime64(3, 'UTC'))} IS NULL
      OR updated_at > {updatedAfter:Nullable(DateTime64(3, 'UTC'))})`
  const inSearchable = `(workspace_id, doc_key, version) IN (
    SELECT workspace_id, doc_key, version FROM tree_view WHERE ${searchable})`
  // For each term, at most 1000 chunks of searchable documents: the cap
  // before the score. The cap takes the chunks in the order of a hash of
  // their key: a fixed sample, so the same query always takes the same
  // chunks (ADR-068, CTX-1547). The branches of the terms read only the text
  // index and the sort key. The filter and the cap then apply one time to
  // all of them: a filter in each branch evaluated the tree view again for
  // each term (CTX-1576). Only the parameter names go into the SQL text.
  const termCap = 1000
  const termMatches = `SELECT word, workspace_id, doc_key, version, ordinal
    FROM (${uniqueTerms
      .map(
        (_, i) => `SELECT {term${i}:String} AS word,
          workspace_id, doc_key, version, ordinal
        FROM chunks
        WHERE ${inWorkspaces} AND hasToken(text, {term${i}:String})`,
      )
      .join(" UNION ALL ")})
    WHERE ${inSearchable}
    ORDER BY word, cityHash64(workspace_id, doc_key, version, ordinal)
    LIMIT ${termCap} BY word`
  // The BM25 IDF of each term: ln(1 + (N - n + 0.5) / (n + 0.5)), with N the
  // chunks of the Workspaces and n the chunks that have the term. The counts
  // read only the text index and the sort key, not the tree view.
  const termWeights = `SELECT word, found,
      log(1 + (total - found + 0.5) / (found + 0.5)) AS idf
    FROM (${uniqueTerms
      .map(
        (_, i) => `SELECT {term${i}:String} AS word, count() AS found
        FROM chunks
        WHERE ${inWorkspaces} AND hasToken(text, {term${i}:String})`,
      )
      .join(" UNION ALL ")}) AS counts
    CROSS JOIN (SELECT count() AS total FROM chunks
      WHERE ${inWorkspaces}) AS totals`
  const vectorOrder = async () => {
    const queryVector = await vector
    return selectIn<ChunkKey>(
      client,
      scope,
      "search.vector",
      // The filter on the documents applies before the top 500 (and before the
      // cap of each term), so that a narrow filter still finds chunks. Index
      // analysis of the large set cost more than it saved: 60 ms against
      // 34 ms on 1 million chunks. Many chunks can have the same Hamming
      // distance, so the key decides between them at the cut: the same query
      // always takes the same 500 (CTX-1547).
      `WITH tree_view AS (${treeView})
       SELECT workspace_id AS workspaceId, doc_key AS docKey, version, ordinal
       FROM (
         SELECT workspace_id, doc_key, version, ordinal, embedding FROM chunks
         WHERE ${inWorkspaces} AND ${inSearchable}
         ORDER BY bitHammingDistance(embedding_bits, unhex({queryBits:String})),
           workspace_id, doc_key, version, ordinal
         LIMIT 500
       )
       ORDER BY cosineDistance(embedding, {queryVector:Array(Float32)}),
         workspaceId, docKey, ordinal
       SETTINGS use_index_for_in_with_subqueries = 0`,
      { ...params, queryVector, queryBits: vectorBits(queryVector) },
    )
  }
  const [vectorRows, lexicalRows] = await Promise.all([
    vectorOrder(),
    uniqueTerms.length === 0
      ? []
      : selectIn<ChunkKey & { share: number }>(
          client,
          scope,
          "search.lexical",
          // The score: the weights of the matched terms of the chunk, plus 4
          // times the weights of the query terms in the title of its document
          // (the title boost, CTX-1564). The weights are one scalar map, so
          // their counts run once.
          // A parallel sum adds the weights in another order on each run, so
          // the score is rounded: equal scores then sort by the key.
          `WITH tree_view AS (${treeView}),
             (SELECT (CAST((groupArray(word), groupArray(idf)),
                 'Map(String, Float64)'),
                 groupArrayIf(word, found BETWEEN 1 AND ${termCap}),
                 sumIf(idf, found BETWEEN 1 AND ${termCap}))
               FROM (${termWeights})) AS terms,
             terms.1 AS weights, terms.2 AS uncapped, terms.3 AS uncappedWeight
           SELECT matches.workspace_id AS workspaceId,
             matches.doc_key AS docKey, matches.version AS version,
             matches.ordinal AS ordinal,
             round(if(uncappedWeight = 0, 1,
               matches.uncappedMatch / uncappedWeight), 9) AS share
           FROM (
             SELECT workspace_id, doc_key, version, ordinal,
               sum(weights[word]) AS weight,
               sumIf(weights[word], has(uncapped, word)) AS uncappedMatch
             FROM (${termMatches})
             GROUP BY workspace_id, doc_key, version, ordinal
           ) AS matches
           INNER JOIN (
             SELECT workspace_id, doc_key, version, title FROM documents
             WHERE ${inWorkspaces}
           ) AS documents
             ON documents.workspace_id = matches.workspace_id
             AND documents.doc_key = matches.doc_key
             AND documents.version = matches.version
           ORDER BY round(matches.weight + 4 * arraySum(
               word -> if(has(splitByNonAlpha(documents.title), word),
                 weights[word], 0),
               mapKeys(weights)), 9) DESC,
             workspaceId, docKey, ordinal
           SETTINGS use_index_for_in_with_subqueries = 0`,
          params,
        ),
  ])

  // RRF with a weight for each lexical place (CTX-1564). The share of a
  // lexical chunk is the part of the summed weight of the uncapped query
  // terms that it has. An uncapped term is in 1 to 1000 chunks of the
  // Workspaces (before the filters, as the term counts), so the cap of its
  // branch never cuts a chunk, and the share is exact. A common term and a
  // term that no chunk has do not count. A query with no uncapped term
  // gives each lexical chunk the share 1. For a question in sentences, most
  // top lexical chunks have only common words of it, so a lexical chunk
  // with a small share counts 0.4 of a vector chunk at the same place. The
  // weight goes to 1 with the square of the share: a chunk with all terms
  // of a short query keeps the full weight. The share is rounded, as the
  // lexical score is, so that a parallel sum gives the same share on each
  // run.
  const fused = new Map<string, ChunkKey & { score: number }>()
  const fuse = (key: ChunkKey, index: number, weight: number) => {
    const id = chunkId(key)
    const hit = fused.get(id) ?? { ...key, score: 0 }
    hit.score += weight / (60 + index + 1)
    fused.set(id, hit)
  }
  vectorRows.forEach((key, index) => fuse(key, index, 1))
  lexicalRows.forEach(({ share, ...key }, index) =>
    fuse(key, index, 0.4 + 0.6 * share ** 2),
  )
  // The top SEARCH_HITS documents, each with its best chunks.
  const byDocument = new Map<string, (ChunkKey & { score: number })[]>()
  for (const hit of [...fused.values()].sort((a, b) => b.score - a.score)) {
    const id = documentId(hit)
    let chunks = byDocument.get(id)
    if (!chunks) {
      if (byDocument.size === SEARCH_HITS) continue
      chunks = []
      byDocument.set(id, chunks)
    }
    if (chunks.length < chunksPerDocument) chunks.push(hit)
  }
  const top = [...byDocument.values()].flat()
  if (top.length === 0) return []

  const [documents, texts, closest] = await Promise.all([
    selectIn<DocumentRecord & { workspaceId: string; version: string }>(
      client,
      scope,
      "search.documents",
      `WITH tree_view AS (${treeView})
       SELECT v.workspace_id AS workspaceId, v.version AS version,
         ${viewDocumentColumns}
       FROM ${viewDocumentsFrom(`kind = 'file' AND status = 'active'
         AND (workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}`)}`,
      { refs: refTuples(top) },
    ),
    selectIn<ChunkKey & ChunkLines>(
      client,
      scope,
      "search.chunks",
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, version, ordinal,
         text, start_line AS startLine, end_line AS endLine
       FROM chunks WHERE ${inWorkspaces}
         AND (workspace_id, doc_key, version, ordinal) IN {keys:Array(Tuple(String, String, String, UInt32))}`,
      {
        keys: top.map(
          (hit) =>
            new TupleParam([
              hit.workspaceId,
              hit.docKey,
              hit.version,
              hit.ordinal,
            ]),
        ),
      },
    ),
    neighbors && neighbors.places > 0
      ? untilAborted(
          neighbors.signal,
          [],
          searchNeighbors(client, scope, {
            // The first chunk of each document has its version in the view.
            seeds: [...byDocument.values()]
              .slice(0, neighbors.from)
              .flatMap((chunks) => chunks.slice(0, 1)),
            hits: [...byDocument.values()].flatMap((chunks) =>
              chunks.slice(0, 1),
            ),
            searchable,
            filters,
            vector: await vector,
            chunksPerDocument,
            places: neighbors.places,
          }),
        )
      : [],
  ])
  const documentById = new Map(
    documents.map(({ workspaceId, version, ...record }) => [
      documentId({ workspaceId, docKey: record.docKey }),
      { version, record },
    ]),
  )
  const textById = new Map(texts.map((row) => [chunkId(row), row]))
  const hits = [...byDocument].flatMap(([id, bestChunks]): SearchHit[] => {
    const current = documentById.get(id)
    // A chunk of a file version that the view does not show any more is
    // not a hit.
    const chunks = bestChunks.filter(
      (chunk) => chunk.version === current?.version,
    )
    const first = chunks[0]
    if (!current || !first) return []
    return [
      {
        workspaceId: first.workspaceId,
        document: toDocument(current.record),
        chunks: chunks.map((chunk) => {
          const text = textById.get(chunkId(chunk))
          return {
            ordinal: chunk.ordinal,
            text: text?.text ?? "",
            startLine: text?.startLine ?? 0,
            endLine: text?.endLine ?? 0,
            score: chunk.score,
          }
        }),
      },
    ]
  })
  if (closest.length === 0) return hits
  // A neighbor takes the score of the hit whose place it takes (else of the
  // last hit), so that the search order keeps it there when Jev does not
  // judge.
  const kept = hits.slice(0, SEARCH_HITS - closest.length)
  return [
    ...kept,
    ...closest.map(({ workspaceId, document, chunks }, index) => {
      const score =
        hits[kept.length + index]?.chunks[0]?.score ??
        hits.at(-1)?.chunks[0]?.score ??
        0
      return {
        workspaceId,
        document,
        chunks: chunks.map(({ distance: _distance, ...chunk }) => ({
          ...chunk,
          score,
        })),
      }
    }),
  ]
}

/** `read`, or `fallback` when `signal` aborts first. */
function untilAborted<T>(
  signal: AbortSignal | undefined,
  fallback: T,
  read: Promise<T>,
): Promise<T> {
  if (!signal) return read
  return Promise.race([
    read,
    new Promise<T>((resolve) => {
      if (signal.aborted) resolve(fallback)
      else
        signal.addEventListener("abort", () => resolve(fallback), {
          once: true,
        })
    }),
  ])
}

/**
 * The `places` neighbors of the hits `seeds` that are closest to `vector`,
 * each with its `chunksPerDocument` chunks closest to it (step 4 of
 * `search`). A neighbor is a document that a seed has a relation to, in
 * either direction, except a `FROM_SOURCE` relation, as in `readFrontier`:
 * an out-relation to a reference key goes to the documents of the key, and
 * an in-relation can name the seed or a key of the seed. The relation and
 * the file version that it comes from must be in the view. The neighbor
 * must pass `searchable` and not be one of `hits`.
 *
 * One query finds the neighbors, then two reads by file version get their
 * chunks and their documents. ClickHouse evaluates a CTE again at each use,
 * so the query uses each CTE one time (CTX-1683, ADR-068 decision 1).
 */
async function searchNeighbors(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  input: {
    seeds: ChunkKey[]
    hits: ChunkKey[]
    /** The condition on a tree row of the view that the search can find. */
    searchable: string
    /** The parameters of `searchable`. */
    filters: Record<string, unknown>
    vector: number[]
    chunksPerDocument: number
    places: number
  },
): Promise<Evidence[]> {
  const versions = (keys: Omit<ChunkKey, "ordinal">[]) =>
    keys.map(
      (key) => new TupleParam([key.workspaceId, key.docKey, key.version]),
    )
  const seedVersions =
    "(workspace_id, doc_key, version) IN {seeds:Array(Tuple(String, String, String))}"
  // A relation to a hidden copy of a seed or of a neighbor counts as a
  // relation to the copy that the view shows (CTX-1697).
  const copies = await readHiddenCopies(client, scope)
  // `exact`: the neighbor must be in the view at `version`. A relation to a
  // document key names no version.
  const neighbors = await selectIn<
    WithDateStrings<
      Pick<
        KnowledgeDocument,
        | "docKey"
        | "kind"
        | "status"
        | "path"
        | "deletedAt"
        | "createdAt"
        | "updatedAt"
        | "expiresAt"
        | "observedAt"
      >,
      "deletedAt" | "createdAt" | "updatedAt" | "expiresAt" | "observedAt"
    > & { workspaceId: string; version: string }
  >(
    client,
    scope,
    "search.neighbors",
    `WITH tree_view AS (${treeView}),
     candidates AS (
       SELECT o.workspace_id AS workspace_id,
         if(empty(keys.doc_key), o.dst_doc, keys.doc_key) AS doc_key,
         keys.version AS version, NOT empty(keys.doc_key) AS exact
       FROM (
         ${relationsOf("relations", `${viewFiles} AND ${seedVersions}`)}
           AND r.predicate != {fromSource:String}
       ) AS o
       LEFT JOIN (
         SELECT workspace_id, concat({prefix:String}, ref_key) AS target,
           doc_key, version
         FROM doc_refs WHERE ${inWorkspaces}
       ) AS keys
         ON keys.workspace_id = o.workspace_id AND keys.target = o.dst_doc
       UNION ALL
       SELECT workspace_id, src_doc, src_version, true
       FROM relations_in
       WHERE ${inWorkspaces} AND predicate != {fromSource:String} AND (
         (workspace_id, dst_doc) IN {seedDocs:Array(Tuple(String, String))}
         OR (workspace_id, dst_doc) IN (
           SELECT workspace_id, concat({prefix:String}, ref_key)
           FROM doc_refs WHERE ${inWorkspaces} AND ${seedVersions}))
     )
     SELECT DISTINCT v.workspace_id AS workspaceId, v.doc_key AS docKey,
       v.version AS version, v.doc_kind AS kind,
       toString(v.status) AS status, v.deleted_at AS deletedAt,
       v.path AS path, v.created_at AS createdAt, v.updated_at AS updatedAt,
       v.expires_at AS expiresAt, v.observed_at AS observedAt
     FROM candidates AS c
     INNER JOIN (
       SELECT * FROM tree_view WHERE ${input.searchable}
         AND (workspace_id, doc_key) NOT IN {hits:Array(Tuple(String, String))}
     ) AS v ON v.workspace_id = c.workspace_id AND v.doc_key = c.doc_key
     WHERE NOT c.exact OR c.version = v.version`,
    {
      ...input.filters,
      seeds: versions(input.seeds),
      seedDocs: refTuples(shownRefsAndCopies(input.seeds, copies)),
      ...copyParams(copies),
      hits: refTuples(input.hits),
      prefix: REFERENCE_TARGET_PREFIX,
      fromSource: "FROM_SOURCE",
    },
  )
  if (neighbors.length === 0) return []
  const inNeighbors =
    "(workspace_id, doc_key, version) IN {neighbors:Array(Tuple(String, String, String))}"
  const params = {
    neighbors: versions(neighbors),
    queryVector: input.vector,
    chunksPerDocument: input.chunksPerDocument,
  }
  const [chunks, documents] = await Promise.all([
    selectIn<DocumentRef & ChunkLines & { distance: number }>(
      client,
      scope,
      "search.neighbor_chunks",
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, ordinal, text,
         start_line AS startLine, end_line AS endLine,
         cosineDistance(embedding, {queryVector:Array(Float32)}) AS distance
       FROM chunks WHERE ${inWorkspaces} AND ${inNeighbors}
       ORDER BY distance, ordinal
       LIMIT {chunksPerDocument:UInt32} BY workspace_id, doc_key`,
      params,
    ),
    selectIn<
      DocumentRef &
        Pick<
          KnowledgeDocument,
          "error" | "title" | "sourceType" | "source" | "summary" | "mime"
        >
    >(
      client,
      scope,
      "search.neighbor_documents",
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, error, title,
         source_type AS sourceType, source, summary, mime
       FROM documents WHERE ${inWorkspaces} AND ${inNeighbors}`,
      params,
    ),
  ])
  const fieldsOf = new Map(
    documents.map(({ workspaceId, docKey, ...fields }) => [
      documentId({ workspaceId, docKey }),
      fields,
    ]),
  )
  const chunksOf = new Map<string, Evidence["chunks"]>()
  for (const { workspaceId, docKey, ...chunk } of chunks) {
    const id = documentId({ workspaceId, docKey })
    chunksOf.set(id, [...(chunksOf.get(id) ?? []), chunk])
  }
  // The closest first; the path decides between equal distances.
  return neighbors
    .flatMap(({ workspaceId, version: _version, ...row }): Evidence[] => {
      const id = documentId({ workspaceId, docKey: row.docKey })
      const closest = chunksOf.get(id)
      if (!closest?.length) return []
      const fields = fieldsOf.get(id)
      return [
        {
          workspaceId,
          document: toDocument({
            ...row,
            error: fields?.error ?? "",
            title: fields?.title ?? "",
            sourceType: fields?.sourceType ?? "",
            source: fields?.source ?? "",
            summary: fields?.summary ?? "",
            mime: fields?.mime ?? "",
          }),
          chunks: closest,
        },
      ]
    })
    .sort(
      (a, b) =>
        (a.chunks[0]?.distance ?? 0) - (b.chunks[0]?.distance ?? 0) ||
        a.document.path.localeCompare(b.document.path),
    )
    .slice(0, input.places)
}

/**
 * The reference keys of the file versions of the view that pass `where` (a
 * condition on `doc_refs`), each as the relation target that names it
 * (`ref:<key>`), with its document.
 */
const keyTargets = (where: string) =>
  `SELECT workspace_id, concat({prefix:String}, ref_key) AS target, doc_key
   FROM doc_refs
   WHERE ${inWorkspaces} AND (${where})
     AND (workspace_id, doc_key, version) IN (
       SELECT workspace_id, doc_key, version FROM tree_view WHERE kind = 'file')`

/**
 * The target of the relation `alias` after the join with `keyTargets AS
 * keys`: the document of its key, else `dst_doc` (a document key, or a key
 * with no document).
 */
const resolvedTarget = (alias: string) =>
  `if(empty(keys.doc_key), ${alias}.dst_doc, keys.doc_key)`

/**
 * The relations of the frontier `refs` in both directions, in one query: the
 * out-relations from `relations` and the in-relations from `relations_in`
 * (sorted by `dst_doc`). Only the relations of the file versions of the view
 * count. Each relation has the document of its neighbor in the view, or a
 * `missing` document when the view has no row for it (ADR-071 decision 5).
 * No time filters the relations: each relation shows its `validFrom` and
 * `validTo`, and the agent judges them (CTX-1710).
 *
 * A relation to a reference key resolves through `doc_refs` (ADR-066
 * decision 5): an out-relation comes one time for each document of the key,
 * else one time with a `missing` neighbor; an in-relation to a key of a
 * frontier document has that document as `dstDoc`. Two keys of one target
 * give one relation when all its fields are the same.
 *
 * A `MENTIONS` relation of an issue (CTX-1502) names a key that most often
 * has no document. Such a relation is not returned: it is not a broken
 * link. Each other one gets the confidence of {@link mentionConfidence}, so
 * a key that many files mention (the name of the whole project) is weak.
 * The mentions of one target by one file give one relation, with the
 * chunk and the confidence of the strongest. A Linear id key with no
 * document is not returned either (CTX-1716): a mirror with a project scope
 * does not write the team and the labels of its issues.
 *
 * With `direction` `out`, the query reads no in-relations (CTX-1688). The
 * claims of the search hits are out-relations only. For a hub document,
 * the in-relations can use most of the time of the read and give most of
 * its rows.
 */
async function readFrontier(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  refs: DocumentRef[],
  direction: "out" | "both" = "both",
): Promise<FrontierRelation[]> {
  assertReadScope(scope)
  if (refs.length === 0) return []
  // A frontier document is the copy that the view shows; its hidden copies
  // find the in-relations to them (CTX-1697).
  const copies = await readHiddenCopies(client, scope)
  const edgeColumns = `workspace_id, src_doc, src_chunk, predicate, dst_doc,
    confidence, valid_from, valid_to, source, alt_text, observed_at`
  const isKey = (column: string) => `startsWith(${column}, {prefix:String})`
  const inRefs = (columns: string) =>
    `(${columns}) IN {refs:Array(Tuple(String, String))}`
  // The in-relations: to a frontier document, or to a key of it.
  const inCtes = `own_keys AS (
       SELECT workspace_id, concat({prefix:String}, ref_key) AS target, doc_key
       FROM doc_refs
       WHERE ${inWorkspaces} AND (workspace_id, doc_key, version) IN (
         SELECT workspace_id, doc_key, version FROM frontier)
     ),
     in_edges AS (
       ${relationsOf("relations_in", viewFiles)}
         AND (${inRefs("r.workspace_id, r.dst_doc")}
           OR (r.workspace_id, r.dst_doc) IN (
             SELECT workspace_id, target FROM own_keys))
     ),`
  const inBranches = `UNION ALL
       SELECT 'in', src_doc, '', ${edgeColumns}
       FROM in_edges WHERE ${inRefs("workspace_id, dst_doc")}
       UNION ALL
       SELECT 'in', i.src_doc, ${mentionKey("i")}, i.workspace_id, i.src_doc,
         i.src_chunk, i.predicate, k.doc_key, i.confidence, i.valid_from,
         i.valid_to, i.source, i.alt_text, i.observed_at
       FROM in_edges AS i
       INNER JOIN own_keys AS k
         ON k.workspace_id = i.workspace_id AND k.target = i.dst_doc`
  const rows = await selectIn<
    RelationRecord & {
      direction: "out" | "in"
      workspaceId: string
      neighborDoc: string
      viaKey: string
    }
  >(
    client,
    scope,
    "frontier.relations",
    `WITH tree_view AS (${treeView}),
     frontier AS (
       ${viewFiles} AND ${inRefs("workspace_id, doc_key")}
     ),
     out_edges AS (
       ${relationsOf("relations", "SELECT * FROM frontier")}
         AND ${inRefs("r.workspace_id, r.src_doc")}
     ),
${direction === "out" ? "" : inCtes}     edges AS (
       SELECT 'out' AS direction, dst_doc AS neighbor_doc, '' AS via_key,
         ${edgeColumns}
       FROM out_edges WHERE NOT ${isKey("dst_doc")}
       UNION ALL
       SELECT 'out', ${resolvedTarget("o")}, ${mentionKey("o")},
         o.workspace_id, o.src_doc, o.src_chunk, o.predicate,
         ${resolvedTarget("o")}, o.confidence,
         o.valid_from, o.valid_to, o.source, o.alt_text, o.observed_at
       FROM out_edges AS o
       LEFT JOIN (
         ${keyTargets(`ref_key IN (
           SELECT substring(dst_doc, length({prefix:String}) + 1)
           FROM out_edges WHERE ${isKey("dst_doc")})`)}
       ) AS keys
         ON keys.workspace_id = o.workspace_id AND keys.target = o.dst_doc
       WHERE ${isKey("o.dst_doc")}
         AND NOT (${optionalTarget("o")} AND empty(keys.doc_key))
${direction === "out" ? "" : inBranches}
     )
     SELECT DISTINCT direction, via_key AS viaKey,
       workspace_id AS workspaceId, neighbor_doc AS neighborDoc,
       src_doc AS srcDoc, src_chunk AS srcChunk, predicate,
       dst_doc AS dstDoc, confidence, valid_from AS validFrom,
       valid_to AS validTo, source, alt_text AS altText,
       observed_at AS observedAt
     FROM edges
     ORDER BY direction DESC, workspaceId, srcDoc, srcChunk, predicate, dstDoc`,
    {
      refs: refTuples(shownRefsAndCopies(refs, copies)),
      prefix: REFERENCE_TARGET_PREFIX,
      ...copyParams(copies),
    },
  )
  // The neighbor documents and the mention counts are two more queries, in
  // parallel. A join of the neighbors in the edge query evaluated the edges
  // two more times (ClickHouse inlines each use of a CTE): 440 ms against
  // 105 ms for the edges alone on the question set v0 (CTX-1535).
  const mentionKeys = new Map<string, [string, string]>()
  const neighborRefs = new Map<string, DocumentRef>()
  for (const { workspaceId, viaKey, neighborDoc } of rows) {
    if (viaKey)
      mentionKeys.set(keyId(workspaceId, viaKey), [workspaceId, viaKey])
    const ref = { workspaceId, docKey: neighborDoc }
    neighborRefs.set(documentId(ref), ref)
  }
  const [neighbors, stats] = await Promise.all([
    readDocuments(client, scope, [...neighborRefs.values()], copies),
    readMentionStats(client, scope, [...mentionKeys.values()]),
  ])
  const neighborOf = new Map(
    neighbors.map(({ workspaceId, document }) => [
      documentId({ workspaceId, docKey: document.docKey }),
      document,
    ]),
  )
  const relations = new Map<string, FrontierRelation>()
  for (const { direction, workspaceId, neighborDoc, viaKey, ...row } of rows) {
    const neighbor = neighborOf.get(
      documentId({ workspaceId, docKey: neighborDoc }),
    )
    const relation = toRelation(row)
    const counts = viaKey && stats.get(keyId(workspaceId, viaKey))
    if (counts) relation.confidence = mentionConfidence(row.confidence, counts)
    // One relation for each of its fields but the confidence, with the
    // highest confidence of its keys. A mention also ignores its chunk.
    const id = JSON.stringify([
      direction,
      workspaceId,
      {
        ...relation,
        confidence: 0,
        srcChunk: relation.predicate === "MENTIONS" ? 0 : relation.srcChunk,
      },
    ])
    const seen = relations.get(id)
    if (seen && seen.relation.confidence >= relation.confidence) continue
    relations.set(id, {
      direction,
      workspaceId,
      relation,
      statedConfidence: row.confidence,
      // The view has no row for the target, so it is `missing`.
      neighbor:
        neighbor ?? missingDocument(relation.dstDoc, relation.observedAt),
    })
  }
  return [...relations.values()]
}

/** The id of a (Workspace, key target) pair of a mention. */
const keyId = (workspaceId: string, target: string) =>
  JSON.stringify([workspaceId, target])

/**
 * True for the relation `alias` when a key target of it that names no
 * document is no relation and no broken link: a `MENTIONS` key (CTX-1502)
 * or a Linear id key (CTX-1716).
 */
const optionalTarget = (alias: string) =>
  `(${alias}.predicate = 'MENTIONS' OR startsWith(${alias}.dst_doc, '${REFERENCE_TARGET_PREFIX}${LINEAR_ID_KEY_PREFIX}'))`

/**
 * The key target of the `MENTIONS` relation `alias`, else `''`. Only a
 * mention gets the weight of its key.
 */
const mentionKey = (alias: string) =>
  `if(${alias}.predicate = 'MENTIONS', ${alias}.dst_doc, '')`

/** The counts that weigh a mention of one key (`mentionConfidence`). */
type MentionStats = {
  /** The files of the view that mention the key. */
  sources: number
  /** The documents of the view that state the key. */
  documents: number
  /** The files of the view. */
  files: number
}

/**
 * The confidence of a `MENTIONS` relation to a key at the read: the
 * confidence of its rule, times the specificity of the key, divided by the
 * count of documents that state the key. The specificity is an inverse
 * document frequency, from 1 for a key that one file mentions to 0 for a
 * key that each file mentions. The counts come from the view of the read,
 * because a stored value cannot depend on other files (ADR-066 decision 5).
 */
function mentionConfidence(
  confidence: number,
  { sources, documents, files }: MentionStats,
): number {
  const specificity =
    files > 1
      ? Math.log((files + 1) / (Math.min(sources, files) + 1)) /
        Math.log(files + 1)
      : 1
  return (confidence * specificity) / Math.max(1, documents)
}

/**
 * The {@link MentionStats} of each (Workspace, key target) of `keys` in the
 * view, in one query. The sources come from `relations_in`, which sorts by
 * `dst_doc`, so the query reads only the rows of these keys.
 */
async function readMentionStats(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  keys: [string, string][],
): Promise<Map<string, MentionStats>> {
  if (keys.length === 0) return new Map()
  const rows = await selectIn<{
    workspaceId: string
    target: string
    sources: string | number
    documents: string | number
    files: string | number
  }>(
    client,
    scope,
    "frontier.mention_stats",
    `WITH tree_view AS (${treeView})
     SELECT w.workspace_id AS workspaceId, w.target AS target,
       s.sources AS sources, d.documents AS documents, f.files AS files
     FROM (
       SELECT tupleElement(key, 1) AS workspace_id,
         tupleElement(key, 2) AS target
       FROM (SELECT arrayJoin({keys:Array(Tuple(String, String))}) AS key)
     ) AS w
     LEFT JOIN (
       SELECT r.workspace_id AS workspace_id, r.dst_doc AS target,
         uniqExact(r.src_doc) AS sources
       FROM (${relationsOf("relations_in", viewFiles)}
         AND r.predicate = 'MENTIONS'
         AND (r.workspace_id, r.dst_doc) IN {keys:Array(Tuple(String, String))}
       ) AS r
       GROUP BY workspace_id, target
     ) AS s ON s.workspace_id = w.workspace_id AND s.target = w.target
     LEFT JOIN (
       SELECT workspace_id, target, uniqExact(doc_key) AS documents
       FROM (${keyTargets("ref_key IN {refKeys:Array(String)}")})
       GROUP BY workspace_id, target
     ) AS d ON d.workspace_id = w.workspace_id AND d.target = w.target
     LEFT JOIN (
       SELECT workspace_id, count() AS files FROM tree_view
       WHERE kind = 'file' GROUP BY workspace_id
     ) AS f ON f.workspace_id = w.workspace_id`,
    {
      keys: keys.map((key) => new TupleParam(key)),
      refKeys: [
        ...new Set(
          keys.map(([, target]) =>
            target.slice(REFERENCE_TARGET_PREFIX.length),
          ),
        ),
      ],
      prefix: REFERENCE_TARGET_PREFIX,
    },
  )
  return new Map(
    rows.map((row) => [
      keyId(row.workspaceId, row.target),
      {
        sources: Number(row.sources),
        documents: Number(row.documents),
        files: Number(row.files),
      },
    ]),
  )
}

/** A `missing` document: a target with no row in the view. */
const missingDocument = (
  docKey: string,
  observedAt: Date,
): KnowledgeDocument => ({
  docKey,
  kind: "",
  status: "missing",
  deletedAt: null,
  error: "",
  title: "",
  path: "",
  sourceType: "",
  source: "",
  summary: "",
  mime: "",
  createdAt: null,
  updatedAt: null,
  expiresAt: null,
  observedAt,
})

/**
 * The document of each of `refs` that the view has. The neighbors of a hub
 * document can be thousands of refs, and ClickHouse refuses a query
 * parameter of more than 128 KiB (`http_max_field_value_size`). Thus the
 * refs go in parallel queries of at most 64 KiB of refs each (CTX-1688),
 * by the length of the escaped and URL-encoded text: a key with
 * characters outside ASCII, or with quotes, has more bytes than
 * characters.
 */
async function readDocuments(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  requested: DocumentRef[],
  /** The hidden copies, when the caller read them. */
  known?: HiddenCopies,
): Promise<{ workspaceId: string; document: KnowledgeDocument }[]> {
  assertReadScope(scope)
  // A hidden copy reads as the copy that the view shows (CTX-1697).
  const refs = shownRefs(
    requested,
    known ?? (await readHiddenCopies(client, scope)),
  )
  // The length of a string of a query parameter in the URL: the client
  // escapes a backslash and a quote, then the URL encodes the text.
  const urlLength = (value: string) =>
    new URLSearchParams({ v: value.replace(/[\\']/g, "\\$&") }).toString()
      .length - 2
  const batches: DocumentRef[][] = []
  let size = Number.POSITIVE_INFINITY
  for (const ref of refs) {
    // The text of the tuple in the URL: each string with its escapes,
    // then the quotes, the comma and the brackets (3 characters each).
    const length = urlLength(ref.workspaceId) + urlLength(ref.docKey) + 24
    if (size + length > 64 * 1024) {
      batches.push([])
      size = 0
    }
    batches.at(-1)?.push(ref)
    size += length
  }
  const rows = await Promise.all(
    batches.map((batch) =>
      selectIn<DocumentRecord & { workspaceId: string }>(
        client,
        scope,
        "documents",
        `WITH tree_view AS (${treeView})
         SELECT v.workspace_id AS workspaceId, ${viewDocumentColumns}
         FROM ${viewDocumentsFrom(
           "(workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}",
         )}`,
        { refs: refTuples(batch) },
      ),
    ),
  )
  // The order of one query: ORDER BY workspaceId, docKey (UTF-8 bytes).
  const byBytes = (a: string, b: string) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b))
  return rows
    .flat()
    .sort(
      (a, b) =>
        byBytes(a.workspaceId, b.workspaceId) || byBytes(a.docKey, b.docKey),
    )
    .map(({ workspaceId, ...record }) => ({
      workspaceId,
      document: toDocument(record),
    }))
}

/**
 * The evidence of the documents `refs`: each document of the view with the
 * `chunksPerDocument` chunks of its file version closest to `vector`
 * (cosine distance).
 */
async function readEvidence(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  refs: DocumentRef[],
  vector: number[],
  chunksPerDocument: number,
): Promise<Evidence[]> {
  assertReadScope(scope)
  if (refs.length === 0) return []
  const params = {
    refs: refTuples(shownRefs(refs, await readHiddenCopies(client, scope))),
    queryVector: vector,
    chunksPerDocument,
  }
  const inRefs =
    "(workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}"
  const [documents, chunks] = await Promise.all([
    selectIn<DocumentRecord & { workspaceId: string }>(
      client,
      scope,
      "evidence.documents",
      `WITH tree_view AS (${treeView})
       SELECT v.workspace_id AS workspaceId, ${viewDocumentColumns}
       FROM ${viewDocumentsFrom(inRefs)}`,
      params,
    ),
    selectIn<DocumentRef & ChunkLines & { distance: number }>(
      client,
      scope,
      "evidence.chunks",
      `WITH tree_view AS (${treeView})
       SELECT workspace_id AS workspaceId, doc_key AS docKey, ordinal, text,
         start_line AS startLine, end_line AS endLine,
         cosineDistance(embedding, {queryVector:Array(Float32)}) AS distance
       FROM chunks WHERE ${inWorkspaces}
         AND (workspace_id, doc_key, version) IN (
           SELECT workspace_id, doc_key, version FROM tree_view
           WHERE kind = 'file' AND ${inRefs})
       ORDER BY distance, ordinal
       LIMIT {chunksPerDocument:UInt32} BY workspace_id, doc_key`,
      params,
    ),
  ])
  const evidence = new Map<string, Evidence>(
    documents.map(({ workspaceId, ...record }) => [
      documentId({ workspaceId, docKey: record.docKey }),
      { workspaceId, document: toDocument(record), chunks: [] },
    ]),
  )
  for (const { workspaceId, docKey, ...chunk } of chunks)
    evidence.get(documentId({ workspaceId, docKey }))?.chunks.push(chunk)
  return [...evidence.values()]
}

/**
 * The documents and the relations of the view for the graph view, each list
 * cut at `limit` rows. `truncated` is true when a list was cut.
 */
async function readGraph(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  limit: number,
): Promise<KnowledgeGraph> {
  assertReadScope(scope)
  const params = {
    limit: limit + 1,
    prefix: REFERENCE_TARGET_PREFIX,
    ...copyParams(await readHiddenCopies(client, scope)),
  }
  const [documents, relations] = await Promise.all([
    selectIn<DocumentRecord>(
      client,
      scope,
      "graph.documents",
      `WITH tree_view AS (${treeView})
       SELECT ${viewDocumentColumns} FROM ${viewDocumentsFrom("1")}
       ORDER BY docKey LIMIT {limit:UInt32}`,
      params,
    ),
    // A relation to a reference key gets the documents of the key
    // (ADR-066 decision 5). Two keys of one target give one relation when
    // all its fields are the same. A `MENTIONS` key or a Linear id key with
    // no document is no relation. The view shows the confidence of the rule
    // of a mention, not the weight of `readFrontier`: the graph view does
    // not rank.
    selectIn<RelationRecord>(
      client,
      scope,
      "graph.relations",
      `WITH tree_view AS (${treeView})
       SELECT DISTINCT rel.src_doc AS srcDoc, rel.src_chunk AS srcChunk,
         rel.predicate AS predicate, ${resolvedTarget("rel")} AS dstDoc,
         rel.confidence AS confidence, rel.valid_from AS validFrom,
         rel.valid_to AS validTo, rel.source AS source,
         rel.alt_text AS altText, rel.observed_at AS observedAt
       FROM (${relationsOf("relations", viewFiles)}) AS rel
       LEFT JOIN (${keyTargets("1")}) AS keys
         ON keys.workspace_id = rel.workspace_id AND keys.target = rel.dst_doc
       WHERE NOT (${optionalTarget("rel")}
         AND startsWith(rel.dst_doc, {prefix:String}) AND empty(keys.doc_key))
       ORDER BY srcDoc, srcChunk, predicate, dstDoc
       LIMIT {limit:UInt32}`,
      params,
    ),
  ])
  return {
    documents: documents.slice(0, limit).map(toDocument),
    relations: relations.slice(0, limit).map(toRelation),
    truncated: documents.length > limit || relations.length > limit,
  }
}

const listDocumentStatuses = async (
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
) =>
  selectIn<{ docKey: string; status: DocumentStatus }>(
    client,
    scope,
    "document_statuses",
    // An ORDER BY after a UNION ALL sorts only its last SELECT, so the
    // union is a subquery.
    `WITH tree_view AS (${treeView})
     SELECT docKey, status FROM (
       SELECT doc_key AS docKey,
         if(kind = 'deleted', 'deleted', toString(status)) AS status
       FROM tree_view
       UNION ALL
       SELECT DISTINCT rel.dst_doc AS docKey, 'missing' AS status
       FROM (${relationsOf("relations", viewFiles)}) AS rel
       WHERE NOT startsWith(rel.dst_doc, {prefix:String})
         AND (rel.workspace_id, rel.dst_doc) NOT IN (
           SELECT workspace_id, doc_key FROM tree_view)
     )
     ORDER BY docKey`,
    // A relation to a hidden copy is not a missing target (CTX-1697).
    {
      prefix: REFERENCE_TARGET_PREFIX,
      ...copyParams(await readHiddenCopies(client, scope)),
    },
  )

const listUnresolvedReferences = (
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
) =>
  selectIn<{ srcDoc: string; dstDoc: string }>(
    client,
    scope,
    "unresolved_references",
    `WITH tree_view AS (${treeView})
     SELECT DISTINCT rel.src_doc AS srcDoc, rel.dst_doc AS dstDoc
     FROM (${relationsOf("relations", viewFiles)}) AS rel
     WHERE startsWith(rel.dst_doc, {prefix:String})
       AND NOT ${optionalTarget("rel")}
       AND (rel.workspace_id, rel.dst_doc) NOT IN (
         SELECT workspace_id, target FROM (${keyTargets("1")}))
     ORDER BY srcDoc, dstDoc`,
    { prefix: REFERENCE_TARGET_PREFIX },
  )

/** `T` with the fields `K` as the ISO date strings that ClickHouse returns. */
type WithDateStrings<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: null extends T[P] ? string | null : string
}
type DocumentRecord = WithDateStrings<
  KnowledgeDocument,
  "deletedAt" | "createdAt" | "updatedAt" | "expiresAt" | "observedAt"
>
type RelationRecord = WithDateStrings<
  KnowledgeRelation,
  "validFrom" | "validTo" | "observedAt"
>

const toDate = (value: string | null) => (value ? new Date(value) : null)

const toDocument = (record: DocumentRecord): KnowledgeDocument => ({
  ...record,
  deletedAt: toDate(record.deletedAt),
  createdAt: toDate(record.createdAt),
  updatedAt: toDate(record.updatedAt),
  expiresAt: toDate(record.expiresAt),
  observedAt: new Date(record.observedAt),
})

const toRelation = (relation: RelationRecord): KnowledgeRelation => ({
  ...relation,
  validFrom: toDate(relation.validFrom),
  validTo: toDate(relation.validTo),
  observedAt: new Date(relation.observedAt),
})
