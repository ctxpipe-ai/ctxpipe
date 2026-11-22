import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
  TupleParam,
} from "@clickhouse/client"

import { CONNECTOR_MIRROR_ROOTS } from "../domain/codeIngestion/connectorMirrorPaths.js"

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
  validFrom: Date | null
  validTo: Date | null
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
}

/**
 * The key of a file version (ADR-071 decision 2): the document key of its
 * path, and its version (a hash of the blob SHA and the variant).
 */
export type FileVersionKey = { docKey: string; version: string }

/**
 * The fields of a document that the content of its file gives. The tree
 * gives the status of the path, `deletedAt` and `validFrom` (ADR-071
 * decision 3).
 */
export type FileDocument = Omit<
  KnowledgeDocument,
  "status" | "deletedAt" | "error" | "validFrom"
>

/**
 * A relation that a file version states. With `validFromIntroduced`, the
 * read takes `validFrom` from the tree row of the source: the time of the
 * commit that introduced the file on the branch.
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
  validTo: Date | null
}

/**
 * One tree row (ADR-071 decision 3): the file version of a path on a
 * branch, or a tombstone (`deletedAt` is set) that keeps the last file
 * version of the path.
 */
export type TreeEntry = FileVersionKey &
  StoredFileVersion & {
    path: string
    validFrom: Date | null
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

/** One document of a Workspace. */
export type DocumentRef = { workspaceId: string; docKey: string }

export type SearchQuery = {
  /** The query vector, in the vector space of the chunks. */
  vector: number[]
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
  /** Only documents observed after this time. */
  observedAfter?: Date | null
  /** Only documents that are valid at this time. */
  validAt?: Date | null
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
   * no row: it is a missing link of its own kind. A `MENTIONS` key is not
   * in the list: a mention that names no document is not a broken link
   * (CTX-1502).
   */
  listUnresolvedReferences(
    scope: KnowledgeReadScope,
  ): Promise<{ srcDoc: string; dstDoc: string }[]>
  /** The hybrid search of ADR-068 decision 1. */
  search(scope: KnowledgeReadScope, query: SearchQuery): Promise<SearchHit[]>
  /** The out-relations and in-relations of the documents `refs`. */
  readFrontier(
    scope: KnowledgeReadScope,
    refs: DocumentRef[],
    validAt?: Date | null,
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
 */
export function createClickHouseClient(url: string): ClickHouseClient {
  return createClient({
    url,
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
    readEmbeddings: (scope, docKeys, embeddingKeys) =>
      readEmbeddings(client, scope, docKeys, embeddingKeys),
    readImageTexts: (scope, blobShas, model, promptVersion) =>
      readImageTexts(client, scope, blobShas, model, promptVersion),
    writeImageTexts: (scope, rows) => writeImageTexts(client, scope, rows),
    listDocumentStatuses: (scope) => listDocumentStatuses(client, scope),
    listUnresolvedReferences: (scope) =>
      listUnresolvedReferences(client, scope),
    search: (scope, query) => search(client, scope, query),
    readFrontier: (scope, refs, validAt) =>
      readFrontier(client, scope, refs, validAt),
    readDocuments: (scope, refs) => readDocuments(client, scope, refs),
    listViewFiles: (scope, prefix) =>
      selectIn<{ workspaceId: string; path: string; branch: string }>(
        client,
        scope,
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
  validTo: string | null
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
         observed_at AS observedAt, valid_to AS validTo
       FROM documents
       WHERE ${scoped}
         AND (doc_key, version) IN {keys:Array(Tuple(String, String))}`,
      { keys: keyTuples(slice) },
    ))
      found.set(fileVersionId(row), {
        status: row.status,
        kind: row.kind,
        observedAt: new Date(row.observedAt),
        validTo: toDate(row.validTo),
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
    valid_to: string | null
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
    valid_from: string | null
    valid_to: string | null
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
      valid_to: isoOrNull(document.validTo),
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
      valid_from: isoOrNull(entry.validFrom),
      valid_to: isoOrNull(entry.validTo),
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
  validFrom: string | null
  validTo: string | null
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
    // The rows of the tree itself, with its `inherit` rows: no view.
    `SELECT doc_key AS docKey, version, path, status,
       doc_kind AS kind, observed_at AS observedAt, valid_from AS validFrom,
       valid_to AS validTo, deleted_at AS deletedAt,
       kind = 'inherit' AS inherit
     FROM (${newestRows("treeBranches", "treeVersions")}) ORDER BY docKey`,
    {},
  )
  return rows.map((row) => ({
    ...row,
    observedAt: new Date(row.observedAt),
    validFrom: toDate(row.validFrom),
    validTo: toDate(row.validTo),
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
  query: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  assertReadScope(scope)
  const result = await client.query({
    query,
    query_params: {
      ...params,
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
  return result.json<T>()
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
  status, doc_kind, observed_at, valid_from, valid_to, deleted_at`

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
 * The tree view of the heads of a read (ADR-071 decisions 4 and 5). The
 * view of the default branch is its tree. The view of another branch B is
 * the view of the default branch, minus each path of the overlay of B, plus
 * the overlay rows of B: an overlay row wins (layer 1), and an `inherit`
 * row leaves the overlay, so the row of the default branch shows (layer 2).
 * A tombstone of the overlay is a row of the view, so it removes the path.
 * A read with no overlay has no layer 1. A full tree can keep an `inherit`
 * row from the time when it was an overlay (a branch that became the
 * default branch): its path is not in the tree, so the view drops it too.
 *
 * This is the one place of the tree rule. Each read of the view starts with
 * `WITH tree_view AS (${treeView})`.
 */
const treeView = `SELECT ${treeColumns} FROM (
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

/** The tree rows of the view that hold a file version (not a tombstone). */
const viewFiles = `SELECT workspace_id, doc_key, version, valid_from
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
  v.valid_from AS validFrom, v.valid_to AS validTo,
  v.observed_at AS observedAt`

/**
 * The relations of the file versions of `sources` (a subquery with the
 * columns of {@link viewFiles}), with the columns of a relation. A relation
 * with `valid_from_introduced` takes `valid_from` of its source row.
 */
const relationsOf = (table: "relations" | "relations_in", sources: string) =>
  `SELECT r.workspace_id AS workspace_id, r.src_doc AS src_doc,
     r.src_chunk AS src_chunk, r.predicate AS predicate, r.dst_doc AS dst_doc,
     r.confidence AS confidence,
     if(r.valid_from_introduced, s.valid_from, r.valid_from) AS valid_from,
     r.valid_to AS valid_to, r.source AS source, r.alt_text AS alt_text,
     r.observed_at AS observed_at
   FROM ${table} AS r
   INNER JOIN (${sources}) AS s
     ON s.workspace_id = r.workspace_id AND s.doc_key = r.src_doc
     AND s.version = r.src_version
   WHERE r.org_id = {orgId:String}
     AND r.workspace_id IN {workspaceIds:Array(String)}`

/** A time in the text form of a `DateTime64(3, 'UTC')` parameter. */
const clickHouseTime = (time: Date) =>
  time.toISOString().slice(0, 23).replace("T", " ")

/** True for a row with no `validAt`, or with `validAt` in its validity. */
const validDuring = (alias = "") =>
  `({validAt:Nullable(DateTime64(3, 'UTC'))} IS NULL OR (
    (${alias}valid_from IS NULL OR ${alias}valid_from <= {validAt:Nullable(DateTime64(3, 'UTC'))})
    AND (${alias}valid_to IS NULL OR ${alias}valid_to > {validAt:Nullable(DateTime64(3, 'UTC'))})))`

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
 *    chunks through the text index. The score counts the matched terms of a
 *    chunk, plus the terms in the title of its document. A function on `text`
 *    in the SELECT list would read the full text column.
 * 3. RRF (k = 60) fuses the two orders. The top 50 chunks are grouped by
 *    document.
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
    observedAfter = null,
    validAt = null,
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
  const params = {
    queryVector: vector,
    queryBits: vectorBits(vector),
    terms: uniqueTerms,
    kinds,
    pathPrefix,
    sources,
    mirrorRoots: CONNECTOR_MIRROR_ROOTS,
    observedAfter: observedAfter && clickHouseTime(observedAfter),
    validAt: validAt && clickHouseTime(validAt),
    ...Object.fromEntries(uniqueTerms.map((term, i) => [`term${i}`, term])),
  }
  // The tree rows that the search can find: active, and in the filters.
  const searchable = `kind = 'file' AND status = 'active'
    AND (empty({kinds:Array(String)}) OR has({kinds:Array(String)}, doc_kind))
    AND startsWith(path, {pathPrefix:String})
    AND (empty({sources:Array(String)}) OR has({sources:Array(String)},
      ifNull(arrayFirst(root -> path = root OR startsWith(path, concat(root, '/')),
        {mirrorRoots:Array(Nullable(String))}), 'authored')))
    AND ({observedAfter:Nullable(DateTime64(3, 'UTC'))} IS NULL
      OR observed_at > {observedAfter:Nullable(DateTime64(3, 'UTC'))})
    AND ${validDuring()}`
  const inSearchable = `(workspace_id, doc_key, version) IN (
    SELECT workspace_id, doc_key, version FROM tree_view WHERE ${searchable})`
  // One branch for each term, each with at most 1000 chunks of searchable
  // documents: the cap before the score. Only the parameter names go into the
  // SQL text.
  const termMatches = uniqueTerms
    .map(
      (_, i) => `SELECT workspace_id, doc_key, version, ordinal FROM chunks
        WHERE ${inWorkspaces} AND hasToken(text, {term${i}:String})
          AND ${inSearchable}
        LIMIT 1000`,
    )
    .join(" UNION ALL ")
  const [vectorOrder, lexicalOrder] = await Promise.all([
    selectIn<ChunkKey>(
      client,
      scope,
      // The filter on the documents applies before the top 500 (and before the
      // cap of each term), so that a narrow filter still finds chunks. Index
      // analysis of the large set cost more than it saved: 60 ms against
      // 34 ms on 1 million chunks.
      `WITH tree_view AS (${treeView})
       SELECT workspace_id AS workspaceId, doc_key AS docKey, version, ordinal
       FROM (
         SELECT workspace_id, doc_key, version, ordinal, embedding FROM chunks
         WHERE ${inWorkspaces} AND ${inSearchable}
         ORDER BY bitHammingDistance(embedding_bits, unhex({queryBits:String}))
         LIMIT 500
       )
       ORDER BY cosineDistance(embedding, {queryVector:Array(Float32)}),
         workspaceId, docKey, ordinal
       SETTINGS use_index_for_in_with_subqueries = 0`,
      params,
    ),
    uniqueTerms.length === 0
      ? []
      : selectIn<ChunkKey>(
          client,
          scope,
          // The score: the matched terms of the chunk, plus the query terms in
          // the title of its document (the title boost).
          `WITH tree_view AS (${treeView})
           SELECT matches.workspace_id AS workspaceId,
             matches.doc_key AS docKey, matches.version AS version,
             matches.ordinal AS ordinal
           FROM (
             SELECT workspace_id, doc_key, version, ordinal, count() AS matched
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
           ORDER BY matches.matched + length(arrayIntersect(
               splitByNonAlpha(documents.title), {terms:Array(String)})) DESC,
             workspaceId, docKey, ordinal
           SETTINGS use_index_for_in_with_subqueries = 0`,
          params,
        ),
  ])

  const fused = new Map<string, ChunkKey & { score: number }>()
  for (const order of [vectorOrder, lexicalOrder])
    order.forEach((key, index) => {
      const id = chunkId(key)
      const hit = fused.get(id) ?? { ...key, score: 0 }
      hit.score += 1 / (60 + index + 1)
      fused.set(id, hit)
    })
  const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 50)
  if (top.length === 0) return []

  const [documents, texts] = await Promise.all([
    selectIn<DocumentRecord & { workspaceId: string; version: string }>(
      client,
      scope,
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
  ])
  const documentById = new Map(
    documents.map(({ workspaceId, version, ...record }) => [
      documentId({ workspaceId, docKey: record.docKey }),
      { version, record },
    ]),
  )
  const textById = new Map(texts.map((row) => [chunkId(row), row]))
  const hits = new Map<string, SearchHit>()
  for (const chunk of top) {
    const id = documentId(chunk)
    const found = documentById.get(id)
    // A chunk of a file version that the view does not show any more is
    // not a hit.
    if (!found || found.version !== chunk.version) continue
    const hit = hits.get(id) ?? {
      workspaceId: chunk.workspaceId,
      document: toDocument(found.record),
      chunks: [],
    }
    const text = textById.get(chunkId(chunk))
    hit.chunks.push({
      ordinal: chunk.ordinal,
      text: text?.text ?? "",
      startLine: text?.startLine ?? 0,
      endLine: text?.endLine ?? 0,
      score: chunk.score,
    })
    hits.set(id, hit)
  }
  return [...hits.values()]
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
 * With `validAt`, a relation or a neighbor that is not valid at that time is
 * not returned.
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
 * chunk and the confidence of the strongest.
 */
async function readFrontier(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  refs: DocumentRef[],
  validAtTime: Date | null = null,
): Promise<FrontierRelation[]> {
  assertReadScope(scope)
  if (refs.length === 0) return []
  const edgeColumns = `workspace_id, src_doc, src_chunk, predicate, dst_doc,
    confidence, valid_from, valid_to, source, alt_text, observed_at`
  const isKey = (column: string) => `startsWith(${column}, {prefix:String})`
  const inRefs = (columns: string) =>
    `(${columns}) IN {refs:Array(Tuple(String, String))}`
  const rows = await selectIn<
    RelationRecord & {
      direction: "out" | "in"
      workspaceId: string
      neighbor: DocumentRecord
      viaKey: string
    }
  >(
    client,
    scope,
    `WITH tree_view AS (${treeView}),
     frontier AS (
       ${viewFiles} AND ${inRefs("workspace_id, doc_key")}
     ),
     out_edges AS (
       SELECT * FROM (
         ${relationsOf("relations", "SELECT * FROM frontier")}
           AND ${inRefs("r.workspace_id, r.src_doc")}
       ) WHERE ${validDuring()}
     ),
     own_keys AS (
       SELECT workspace_id, concat({prefix:String}, ref_key) AS target, doc_key
       FROM doc_refs
       WHERE ${inWorkspaces} AND (workspace_id, doc_key, version) IN (
         SELECT workspace_id, doc_key, version FROM frontier)
     ),
     in_edges AS (
       SELECT * FROM (
         ${relationsOf("relations_in", viewFiles)}
           AND (${inRefs("r.workspace_id, r.dst_doc")}
             OR (r.workspace_id, r.dst_doc) IN (
               SELECT workspace_id, target FROM own_keys))
       ) WHERE ${validDuring()}
     ),
     edges AS (
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
         AND NOT (o.predicate = 'MENTIONS' AND empty(keys.doc_key))
       UNION ALL
       SELECT 'in', src_doc, '', ${edgeColumns}
       FROM in_edges WHERE ${inRefs("workspace_id, dst_doc")}
       UNION ALL
       SELECT 'in', i.src_doc, ${mentionKey("i")}, i.workspace_id, i.src_doc,
         i.src_chunk, i.predicate, k.doc_key, i.confidence, i.valid_from,
         i.valid_to, i.source, i.alt_text, i.observed_at
       FROM in_edges AS i
       INNER JOIN own_keys AS k
         ON k.workspace_id = i.workspace_id AND k.target = i.dst_doc
     )
     SELECT DISTINCT edges.direction AS direction,
       edges.via_key AS viaKey,
       edges.workspace_id AS workspaceId,
       edges.src_doc AS srcDoc, edges.src_chunk AS srcChunk,
       edges.predicate AS predicate, edges.dst_doc AS dstDoc,
       edges.confidence AS confidence, edges.valid_from AS validFrom,
       edges.valid_to AS validTo, edges.source AS source,
       edges.alt_text AS altText,
       edges.observed_at AS observedAt, neighbors.document AS neighbor
     FROM edges
     LEFT JOIN (
       SELECT v.workspace_id AS workspace_id, v.doc_key AS doc_key,
         v.valid_from AS valid_from, v.valid_to AS valid_to,
         tuple(${viewDocumentColumns}) AS document
       FROM ${viewDocumentsFrom(`(workspace_id, doc_key) IN (
         SELECT workspace_id, neighbor_doc FROM edges)`)}
     ) AS neighbors
       ON neighbors.workspace_id = edges.workspace_id
       AND neighbors.doc_key = edges.neighbor_doc
     WHERE ${validDuring("neighbors.")}
     ORDER BY direction DESC, workspaceId, srcDoc, srcChunk, predicate, dstDoc`,
    {
      refs: refTuples(refs),
      validAt: validAtTime && clickHouseTime(validAtTime),
      prefix: REFERENCE_TARGET_PREFIX,
    },
  )
  const mentionKeys = new Map<string, [string, string]>()
  for (const { workspaceId, viaKey } of rows)
    if (viaKey)
      mentionKeys.set(keyId(workspaceId, viaKey), [workspaceId, viaKey])
  const stats = await readMentionStats(client, scope, [...mentionKeys.values()])
  const relations = new Map<string, FrontierRelation>()
  for (const { direction, workspaceId, neighbor, viaKey, ...row } of rows) {
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
      // Without a match, the LEFT JOIN gives a tuple of default values: the
      // view has no row for the target, so it is `missing`.
      neighbor: neighbor.docKey
        ? toDocument(neighbor)
        : missingDocument(relation.dstDoc, relation.observedAt),
    })
  }
  return [...relations.values()]
}

/** The id of a (Workspace, key target) pair of a mention. */
const keyId = (workspaceId: string, target: string) =>
  JSON.stringify([workspaceId, target])

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
  validFrom: null,
  validTo: null,
  observedAt,
})

/** The document of each of `refs` that the view has, in one query. */
async function readDocuments(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  refs: DocumentRef[],
): Promise<{ workspaceId: string; document: KnowledgeDocument }[]> {
  assertReadScope(scope)
  if (refs.length === 0) return []
  const rows = await selectIn<DocumentRecord & { workspaceId: string }>(
    client,
    scope,
    `WITH tree_view AS (${treeView})
     SELECT v.workspace_id AS workspaceId, ${viewDocumentColumns}
     FROM ${viewDocumentsFrom(
       "(workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}",
     )}
     ORDER BY workspaceId, docKey`,
    { refs: refTuples(refs) },
  )
  return rows.map(({ workspaceId, ...record }) => ({
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
    refs: refTuples(refs),
    queryVector: vector,
    chunksPerDocument,
  }
  const inRefs =
    "(workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}"
  const [documents, chunks] = await Promise.all([
    selectIn<DocumentRecord & { workspaceId: string }>(
      client,
      scope,
      `WITH tree_view AS (${treeView})
       SELECT v.workspace_id AS workspaceId, ${viewDocumentColumns}
       FROM ${viewDocumentsFrom(inRefs)}`,
      params,
    ),
    selectIn<DocumentRef & ChunkLines & { distance: number }>(
      client,
      scope,
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
  const params = { limit: limit + 1, prefix: REFERENCE_TARGET_PREFIX }
  const [documents, relations] = await Promise.all([
    selectIn<DocumentRecord>(
      client,
      scope,
      `WITH tree_view AS (${treeView})
       SELECT ${viewDocumentColumns} FROM ${viewDocumentsFrom("1")}
       ORDER BY docKey LIMIT {limit:UInt32}`,
      params,
    ),
    // A relation to a reference key gets the documents of the key
    // (ADR-066 decision 5). Two keys of one target give one relation when
    // all its fields are the same. A `MENTIONS` key with no document is no
    // relation. The view shows the confidence of the rule of a mention, not
    // the weight of `readFrontier`: the graph view does not rank.
    selectIn<RelationRecord>(
      client,
      scope,
      `WITH tree_view AS (${treeView})
       SELECT DISTINCT rel.src_doc AS srcDoc, rel.src_chunk AS srcChunk,
         rel.predicate AS predicate, ${resolvedTarget("rel")} AS dstDoc,
         rel.confidence AS confidence, rel.valid_from AS validFrom,
         rel.valid_to AS validTo, rel.source AS source,
         rel.alt_text AS altText, rel.observed_at AS observedAt
       FROM (${relationsOf("relations", viewFiles)}) AS rel
       LEFT JOIN (${keyTargets("1")}) AS keys
         ON keys.workspace_id = rel.workspace_id AND keys.target = rel.dst_doc
       WHERE NOT (rel.predicate = 'MENTIONS'
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

const listDocumentStatuses = (
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
) =>
  selectIn<{ docKey: string; status: DocumentStatus }>(
    client,
    scope,
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
    { prefix: REFERENCE_TARGET_PREFIX },
  )

const listUnresolvedReferences = (
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
) =>
  selectIn<{ srcDoc: string; dstDoc: string }>(
    client,
    scope,
    `WITH tree_view AS (${treeView})
     SELECT DISTINCT rel.src_doc AS srcDoc, rel.dst_doc AS dstDoc
     FROM (${relationsOf("relations", viewFiles)}) AS rel
     WHERE startsWith(rel.dst_doc, {prefix:String})
       AND rel.predicate != 'MENTIONS'
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
  "deletedAt" | "validFrom" | "validTo" | "observedAt"
>
type RelationRecord = WithDateStrings<
  KnowledgeRelation,
  "validFrom" | "validTo" | "observedAt"
>

const toDate = (value: string | null) => (value ? new Date(value) : null)

const toDocument = (record: DocumentRecord): KnowledgeDocument => ({
  ...record,
  deletedAt: toDate(record.deletedAt),
  validFrom: toDate(record.validFrom),
  validTo: toDate(record.validTo),
  observedAt: new Date(record.observedAt),
})

const toRelation = (relation: RelationRecord): KnowledgeRelation => ({
  ...relation,
  validFrom: toDate(relation.validFrom),
  validTo: toDate(relation.validTo),
  observedAt: new Date(relation.observedAt),
})
