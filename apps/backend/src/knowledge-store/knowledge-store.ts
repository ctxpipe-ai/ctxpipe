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
 * The fields of a document that its file gives. The store sets `status`,
 * `deletedAt` and `error` itself: each mutation makes one status.
 */
export type ActiveDocument = Omit<
  KnowledgeDocument,
  "status" | "deletedAt" | "error"
>

/** The rows of one document: the relations that it states are its own. */
export type DocumentRows = {
  document: ActiveDocument
  chunks: KnowledgeChunk[]
  relations: Omit<KnowledgeRelation, "srcDoc">[]
  /** The reference keys that the document states for itself. Absent: none. */
  refKeys?: string[]
}

/**
 * A document row with no content (ADR-066 decision 7): `missing` for a link
 * target that does not exist in Git, `failed` for a file that did not parse
 * or embed.
 */
type Placeholder = { docKey: string; observedAt: Date } & (
  | { status: "missing" }
  | { status: "failed"; error: string }
)

/**
 * The changes of one write. A key is in one list only. Each list can be
 * empty or absent.
 */
export type DocumentChanges = {
  /** Each document replaces the state of its key, with status `active`. */
  documents?: DocumentRows[]
  /**
   * A `failed` placeholder replaces the state of its key. A `missing`
   * placeholder is only for a key with no row (ADR-067 decision 7): it never
   * replaces a document or a tombstone.
   */
  placeholders?: Placeholder[]
  /** Each key becomes a tombstone (ADR-067 decision 6). */
  deleted?: { docKeys: string[]; deletedAt: Date }
}

type DocumentKey = { docKey: string; status: DocumentStatus }

type StoredDocument = {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  /** The relations that this document states. */
  outgoing: KnowledgeRelation[]
  /** The relations of other documents (and this one) that point at it. */
  incoming: KnowledgeRelation[]
  /** The reference keys that the document states for itself. */
  refKeys: string[]
}

/** The org and the Workspaces of a read. A read can span Workspaces. */
export type KnowledgeReadScope = { orgId: string; workspaceIds: string[] }

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
 * with that document as `dstDoc`. A key with no document comes one time,
 * with the key as `dstDoc` and a `missing` neighbor.
 */
export type FrontierRelation = {
  /** `out`: the frontier document is `srcDoc`. `in`: it is `dstDoc`. */
  direction: "out" | "in"
  workspaceId: string
  relation: KnowledgeRelation
  /** `null` when the neighbor has no document row. */
  neighbor: KnowledgeDocument | null
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

/**
 * The only ClickHouse client of the knowledge content (ADR-066). Each
 * function takes the org and one or more Workspaces of it, and each statement
 * has org walls:
 * - Reads: `org_id` and `workspace_id` are in the WHERE clause, and the row
 *   policy filters to the org of {@link ORG_SETTING}.
 * - Inserts: this module sets `org_id` and `workspace_id` of each row from
 *   the scope, and the CHECK constraint refuses a row of another org.
 * - DELETE: ClickHouse applies neither the row policy nor the CHECK
 *   constraint. Thus a caller gives only document keys, and
 *   {@link deleteWhere} adds the org and Workspace predicates to each
 *   statement. The backend connects as a user with SELECT only (ADR-066
 *   decision 9).
 *
 * Each change is a DELETE, then an INSERT. There is no UPDATE (ADR-066
 * decision 8). Each DELETE is a mutation of its table, so one write deletes
 * the rows of all its keys with one DELETE for each table. A retry after a
 * failure is safe (ADR-067 decision 5).
 */
export type KnowledgeStore = {
  /**
   * Applies `changes` with one DELETE for each table, for each slice of at
   * most {@link IN_LIST_CAP} keys (ADR-066 decision 8). Each DELETE is a
   * mutation, and the mutations of one table run in order, so a caller
   * gives all changes of a run in as few calls as it can. Returns the count
   * of mutations.
   *
   * - A document or a `failed` placeholder: deletes all rows of its key,
   *   then inserts the new rows.
   * - A tombstone gets status `deleted` and `deletedAt`, with the other
   *   fields of its row. Its chunks, outgoing relations and reference keys
   *   are deleted. The relations of other documents that point at it stay.
   *   A key with no row gets a tombstone with empty fields. A key that has
   *   a tombstone keeps it, with the date of the first deletion.
   *
   * The tombstones go in before the DELETEs, so a failure between the two
   * leaves both rows, never no row: a retry keeps the tombstone and deletes
   * the old row. Until the retry, the key has two rows.
   */
  applyDocuments(
    scope: KnowledgeScope,
    changes: DocumentChanges,
  ): Promise<{ mutations: number }>
  /** The key and the status of each document of the Workspace. */
  listDocumentKeys(scope: KnowledgeScope): Promise<DocumentKey[]>
  /**
   * Each relation target that is a reference key with no document in
   * `doc_refs` (`ref:<key>`), with each document that states it. Such a key
   * has no `missing` row: it is a missing link of its own kind.
   */
  listUnresolvedReferences(
    scope: KnowledgeScope,
  ): Promise<{ srcDoc: string; dstDoc: string }[]>
  readDocument(
    scope: KnowledgeScope,
    docKey: string,
  ): Promise<StoredDocument | null>
  /** The hybrid search of ADR-068 decision 1. */
  search(scope: KnowledgeReadScope, query: SearchQuery): Promise<SearchHit[]>
  /** The out-relations and in-relations of the documents `refs`. */
  readFrontier(
    scope: KnowledgeReadScope,
    refs: DocumentRef[],
    validAt?: Date | null,
  ): Promise<FrontierRelation[]>
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
   * The documents and relations of a Workspace, at most `limit` of each. A
   * relation to a reference key comes one time for each document of the
   * key, with that document as `dstDoc`. A key with no document keeps the
   * key as `dstDoc`.
   */
  readGraph(scope: KnowledgeScope, limit: number): Promise<KnowledgeGraph>
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
  return {
    applyDocuments: (scope, changes) => applyDocuments(client, scope, changes),
    listDocumentKeys: (scope) => listDocumentKeys(client, scope),
    listUnresolvedReferences: (scope) =>
      listUnresolvedReferences(client, scope),
    readDocument: (scope, docKey) => readDocument(client, scope, docKey),
    search: (scope, query) => search(client, scope, query),
    readFrontier: (scope, refs, validAt) =>
      readFrontier(client, scope, refs, validAt),
    readDocuments: (scope, refs) => readDocuments(client, scope, refs),
    readEvidence: (scope, refs, vector, chunksPerDocument) =>
      readEvidence(client, scope, refs, vector, chunksPerDocument),
    readGraph: (scope, limit) => readGraph(client, scope, limit),
    close: () => client.close(),
  }
}

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

/** Runs one read for the Workspace of `scope` (`scoped`). */
async function select<T>(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  assertScope(scope)
  return selectIn<T>(
    client,
    { orgId: scope.orgId, workspaceIds: [scope.workspaceId] },
    query,
    scopeParams(scope, params),
  )
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

/**
 * Deletes the rows of the keys `replaced` and the content of the keys
 * `deleted`, with one DELETE for each table and each slice of keys:
 * - chunks, the outgoing relations (from `relations` and from
 *   `relations_in`) and the reference keys of each key;
 * - each document row of a key of `replaced`, and each row of a key of
 *   `deleted` that is not a tombstone.
 * Returns the count of DELETEs.
 */
async function deleteRows(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  replaced: string[],
  deleted: string[],
): Promise<number> {
  let mutations = 0
  const remove = async (
    table: keyof TableRows,
    where: string,
    params: Record<string, unknown>,
  ) => {
    await deleteWhere(client, scope, table, where, params)
    mutations++
  }
  const deletedKeys = new Set(deleted)
  for (const docKeys of slices([...replaced, ...deleted])) {
    // relations_in sorts by dst_doc, and doc_refs by ref_key. Their DELETEs
    // filter by the targets and the keys of the documents too, so that they
    // use the sort key (CTX-1391). Most documents state no key, and then no
    // DELETE of doc_refs runs.
    const targets = await select<{ dstDoc: string }>(
      client,
      scope,
      `SELECT DISTINCT dst_doc AS dstDoc FROM relations
       WHERE ${scoped} AND src_doc IN {docKeys:Array(String)}`,
      { docKeys },
    )
    const refKeys = await select<{ refKey: string }>(
      client,
      scope,
      `SELECT DISTINCT ref_key AS refKey FROM doc_refs
       WHERE ${scoped} AND doc_key IN {docKeys:Array(String)}`,
      { docKeys },
    )
    await remove("chunks", "doc_key IN {docKeys:Array(String)}", { docKeys })
    // relations_in first: while a row stays in relations, a retry after a
    // failure finds its target again.
    for (const dstDocs of slices(targets.map((target) => target.dstDoc)))
      await remove(
        "relations_in",
        "dst_doc IN {dstDocs:Array(String)} AND src_doc IN {docKeys:Array(String)}",
        { docKeys, dstDocs },
      )
    await remove("relations", "src_doc IN {docKeys:Array(String)}", {
      docKeys,
    })
    for (const keys of slices(refKeys.map((row) => row.refKey)))
      await remove(
        "doc_refs",
        "ref_key IN {refKeys:Array(String)} AND doc_key IN {docKeys:Array(String)}",
        { docKeys, refKeys: keys },
      )
    // The document rows last: while a document row stays, a retry finds
    // the key again.
    await remove(
      "documents",
      "doc_key IN {replaced:Array(String)} OR (doc_key IN {deleted:Array(String)} AND status != 'deleted')",
      {
        replaced: docKeys.filter((docKey) => !deletedKeys.has(docKey)),
        deleted: docKeys.filter((docKey) => deletedKeys.has(docKey)),
      },
    )
  }
  return mutations
}

type StoredRows = Omit<DocumentRows, "document"> & {
  document: KnowledgeDocument
}

async function applyDocuments(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  changes: DocumentChanges,
): Promise<{ mutations: number }> {
  assertScope(scope)
  const documents = changes.documents ?? []
  const placeholders = changes.placeholders ?? []
  const deleted = changes.deleted?.docKeys ?? []
  const missing = placeholders
    .filter((placeholder) => placeholder.status === "missing")
    .map((placeholder) => placeholder.docKey)
  const allKeys = [
    ...documents.map((rows) => rows.document.docKey),
    ...placeholders.map((placeholder) => placeholder.docKey),
    ...deleted,
  ]
  if (new Set(allKeys).size !== allKeys.length)
    throw new Error("A write has the same document key two times")
  if (allKeys.length === 0) return { mutations: 0 }

  const stored = await storedDocuments(client, scope, [...missing, ...deleted])
  const deletedAt = changes.deleted?.deletedAt
  const tombstones: StoredRows[] = deletedAt
    ? deleted
        .filter((docKey) => stored.get(docKey)?.status !== "deleted")
        .map((docKey) => ({
          document: {
            ...(stored.get(docKey) ??
              emptyDocument(docKey, "deleted", deletedAt)),
            status: "deleted",
            deletedAt,
            error: "",
          },
          chunks: [],
          relations: [],
        }))
    : []
  const replacing: StoredRows[] = [
    ...documents.map(({ document, chunks, relations, refKeys }) => ({
      document: { ...document, status: "active" as const, deletedAt: null, error: "" },
      chunks,
      relations,
      refKeys,
    })),
    ...placeholders
      .filter(
        (placeholder) =>
          placeholder.status === "failed" || !stored.has(placeholder.docKey),
      )
      .map((placeholder) => ({
        document: {
          ...emptyDocument(
            placeholder.docKey,
            placeholder.status,
            placeholder.observedAt,
          ),
          error: placeholder.status === "failed" ? placeholder.error : "",
        },
        chunks: [],
        relations: [],
      })),
  ]

  await insertRows(client, scope, tombstones)
  // A key with no document row has no other row: each write deletes the
  // document row last and inserts it first. Thus a `missing` placeholder
  // needs no DELETE.
  const mutations = await deleteRows(
    client,
    scope,
    replacing
      .map((rows) => rows.document)
      .filter((document) => document.status !== "missing")
      .map((document) => document.docKey),
    deleted,
  )
  await insertRows(client, scope, replacing)
  return { mutations }
}

/** A document row with no content fields. */
const emptyDocument = (
  docKey: string,
  status: DocumentStatus,
  observedAt: Date,
): KnowledgeDocument => ({
  docKey,
  kind: "",
  status,
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

/**
 * The stored document row of each key that has one. A key with a tombstone
 * and an old row (a write that stopped between the INSERT of the tombstone
 * and the DELETE of the old row) gives the tombstone.
 */
async function storedDocuments(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKeys: string[],
): Promise<Map<string, KnowledgeDocument>> {
  const stored = new Map<string, KnowledgeDocument>()
  for (const keys of slices(docKeys))
    for (const record of await select<DocumentRecord>(
      client,
      scope,
      `SELECT ${documentColumns} FROM documents
       WHERE ${scoped} AND doc_key IN {docKeys:Array(String)}`,
      { docKeys: keys },
    ))
      if (stored.get(record.docKey)?.status !== "deleted")
        stored.set(record.docKey, toDocument(record))
  return stored
}

const listDocumentKeys = (client: ClickHouseClient, scope: KnowledgeScope) =>
  select<DocumentKey>(
    client,
    scope,
    `SELECT doc_key AS docKey, status FROM documents WHERE ${scoped}
     ORDER BY doc_key`,
  )

const listUnresolvedReferences = (
  client: ClickHouseClient,
  scope: KnowledgeScope,
) =>
  select<{ srcDoc: string; dstDoc: string }>(
    client,
    scope,
    `SELECT DISTINCT src_doc AS srcDoc, dst_doc AS dstDoc FROM relations
     WHERE ${scoped} AND startsWith(dst_doc, {prefix:String})
       AND substring(dst_doc, length({prefix:String}) + 1) NOT IN (
         SELECT ref_key FROM doc_refs WHERE ${scoped})
     ORDER BY srcDoc, dstDoc`,
    { prefix: REFERENCE_TARGET_PREFIX },
  )

/** The columns of each table, as an insert sends them. */
type ScopeColumns = { org_id: string; workspace_id: string }
type RelationColumns = ScopeColumns & {
  src_doc: string
  src_chunk: number
  predicate: string
  dst_doc: string
  confidence: number
  valid_from: string | null
  valid_to: string | null
  source: string
  alt_text: string
  observed_at: string
}
type TableRows = {
  documents: ScopeColumns & {
    doc_key: string
    kind: string
    status: DocumentStatus
    deleted_at: string | null
    error: string
    title: string
    path: string
    source_type: string
    source: string
    summary: string
    mime: string
    valid_from: string | null
    valid_to: string | null
    observed_at: string
  }
  chunks: ScopeColumns & {
    doc_key: string
    ordinal: number
    text: string
    start_line: number
    end_line: number
    embedding: number[]
  }
  relations: RelationColumns
  relations_in: RelationColumns
  doc_refs: ScopeColumns & { ref_key: string; doc_key: string }
}

async function insertRows(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  rows: StoredRows[],
): Promise<void> {
  // The insert wall of this module: each row is made field by field, and the
  // org and Workspace columns come only from the scope. A value that a caller
  // puts in a row does not get into the insert.
  const owner: ScopeColumns = {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
  }
  const insert = async <T extends keyof TableRows>(
    table: T,
    values: TableRows[T][],
  ) => {
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
  await insert(
    "documents",
    rows.map(({ document }) => ({
      ...owner,
      doc_key: document.docKey,
      kind: document.kind,
      status: document.status,
      deleted_at: document.deletedAt?.toISOString() ?? null,
      error: document.error,
      title: document.title,
      path: document.path,
      source_type: document.sourceType,
      source: document.source,
      summary: document.summary,
      mime: document.mime,
      valid_from: document.validFrom?.toISOString() ?? null,
      valid_to: document.validTo?.toISOString() ?? null,
      observed_at: document.observedAt.toISOString(),
    })),
  )
  await insert(
    "chunks",
    rows.flatMap(({ document, chunks }) =>
      chunks.map((chunk) => ({
        ...owner,
        doc_key: document.docKey,
        ordinal: chunk.ordinal,
        text: chunk.text,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        embedding: chunk.embedding,
      })),
    ),
  )
  const relations = rows.flatMap(({ document, relations }) =>
    relations.map((relation) => ({
      ...owner,
      src_doc: document.docKey,
      src_chunk: relation.srcChunk,
      predicate: relation.predicate,
      dst_doc: relation.dstDoc,
      confidence: relation.confidence,
      valid_from: relation.validFrom?.toISOString() ?? null,
      valid_to: relation.validTo?.toISOString() ?? null,
      source: relation.source,
      alt_text: relation.altText,
      observed_at: relation.observedAt.toISOString(),
    })),
  )
  // relations first: deleteContent finds the rows of relations_in through
  // relations, so a failure between the two inserts leaves no row that a
  // retry cannot find.
  await insert("relations", relations)
  await insert("relations_in", relations)
  await insert(
    "doc_refs",
    rows.flatMap(({ document, refKeys = [] }) =>
      [...new Set(refKeys)].map((refKey) => ({
        ...owner,
        ref_key: refKey,
        doc_key: document.docKey,
      })),
    ),
  )
}

const documentColumns = `doc_key AS docKey, kind, status,
  deleted_at AS deletedAt, error, title, path, source_type AS sourceType,
  source, summary, mime, valid_from AS validFrom,
  valid_to AS validTo, observed_at AS observedAt`

const relationColumns = `src_doc AS srcDoc, src_chunk AS srcChunk, predicate,
  dst_doc AS dstDoc, confidence, valid_from AS validFrom, valid_to AS validTo,
  source, alt_text AS altText, observed_at AS observedAt`

async function readDocument(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKey: string,
): Promise<StoredDocument | null> {
  const params = { docKey }
  const [documents, chunks, outgoing, incoming, refKeys] = await Promise.all([
    select<DocumentRecord>(
      client,
      scope,
      `SELECT ${documentColumns} FROM documents
       WHERE ${scoped} AND doc_key = {docKey:String}`,
      params,
    ),
    select<KnowledgeChunk>(
      client,
      scope,
      `SELECT ordinal, text, start_line AS startLine, end_line AS endLine,
         embedding FROM chunks
       WHERE ${scoped} AND doc_key = {docKey:String} ORDER BY ordinal`,
      params,
    ),
    select<RelationRecord>(
      client,
      scope,
      `SELECT ${relationColumns} FROM relations
       WHERE ${scoped} AND src_doc = {docKey:String}
       ORDER BY src_chunk, predicate, dst_doc`,
      params,
    ),
    select<RelationRecord>(
      client,
      scope,
      `SELECT ${relationColumns} FROM relations_in
       WHERE ${scoped} AND dst_doc = {docKey:String}
       ORDER BY src_doc, src_chunk, predicate`,
      params,
    ),
    select<{ refKey: string }>(
      client,
      scope,
      `SELECT ref_key AS refKey FROM doc_refs
       WHERE ${scoped} AND doc_key = {docKey:String} ORDER BY ref_key`,
      params,
    ),
  ])
  const [document] = documents
  if (!document) return null
  return {
    document: toDocument(document),
    chunks,
    outgoing: outgoing.map(toRelation),
    incoming: incoming.map(toRelation),
    refKeys: refKeys.map((row) => row.refKey),
  }
}

// ---------------------------------------------------------------------------
// Reads for the retrieval (ADR-068). A read can span several Workspaces of one
// org. Each one goes through `selectIn`, which sets the org of the row policy,
// and each WHERE clause has `org_id` and `workspace_id`. Values go in
// `query_params` only, never into the SQL text.

/**
 * Runs one read for the Workspaces of `scope`. The org and the Workspaces
 * come last in the parameters, so that the WHERE clause and the row policy
 * use the same org.
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
      workspaceIds: scope.workspaceIds,
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

const inWorkspaces =
  "org_id = {orgId:String} AND workspace_id IN {workspaceIds:Array(String)}"

/** A time in the text form of a `DateTime64(3, 'UTC')` parameter. */
const clickHouseTime = (time: Date) =>
  time.toISOString().slice(0, 23).replace("T", " ")

/** True for a row with no `validAt`, or with `validAt` in its validity. */
const validDuring = (alias = "") =>
  `({validAt:Nullable(DateTime64(3, 'UTC'))} IS NULL OR (
    (${alias}valid_from IS NULL OR ${alias}valid_from <= {validAt:Nullable(DateTime64(3, 'UTC'))})
    AND (${alias}valid_to IS NULL OR ${alias}valid_to > {validAt:Nullable(DateTime64(3, 'UTC'))})))`

function assertReadScope(scope: KnowledgeReadScope): void {
  if (
    !scope.orgId ||
    scope.workspaceIds.length === 0 ||
    scope.workspaceIds.some((workspaceId) => !workspaceId)
  )
    throw new Error("A knowledge read needs an org and its Workspaces")
}

/** The binary form of a vector, as hex: the same bits as `embedding_bits`. */
function vectorBits(vector: number[]): string {
  const bytes = new Uint8Array(Math.ceil(vector.length / 8))
  vector.forEach((value, index) => {
    if (value > 0)
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (0x80 >> (index & 7))
  })
  return Buffer.from(bytes).toString("hex")
}

type ChunkKey = { workspaceId: string; docKey: string; ordinal: number }
const chunkId = (key: ChunkKey) =>
  JSON.stringify([key.workspaceId, key.docKey, key.ordinal])
/** The key of a document of a read: its Workspace and its document key. */
export const documentId = (ref: DocumentRef) =>
  JSON.stringify([ref.workspaceId, ref.docKey])
/** The value of a `{refs:Array(Tuple(String, String))}` parameter. */
const refTuples = (refs: DocumentRef[]) =>
  refs.map((ref) => new TupleParam([ref.workspaceId, ref.docKey]))

/**
 * The hybrid search of ADR-068 decision 1:
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
 * Only `active` documents that pass the filters are found.
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
  // The documents that the search can find: active, and in the filters.
  const searchable = `${inWorkspaces} AND status = 'active'
    AND (empty({kinds:Array(String)}) OR has({kinds:Array(String)}, kind))
    AND startsWith(path, {pathPrefix:String})
    AND (empty({sources:Array(String)}) OR has({sources:Array(String)},
      ifNull(arrayFirst(root -> path = root OR startsWith(path, concat(root, '/')),
        {mirrorRoots:Array(Nullable(String))}), 'authored')))
    AND ({observedAfter:Nullable(DateTime64(3, 'UTC'))} IS NULL
      OR observed_at > {observedAfter:Nullable(DateTime64(3, 'UTC'))})
    AND ${validDuring()}`
  const inSearchable = `(workspace_id, doc_key) IN (
    SELECT workspace_id, doc_key FROM documents WHERE ${searchable})`
  // One branch for each term, each with at most 1000 chunks of searchable
  // documents: the cap before the score. Only the parameter names go into the
  // SQL text.
  const termMatches = uniqueTerms
    .map(
      (_, i) => `SELECT workspace_id, doc_key, ordinal FROM chunks
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
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, ordinal
       FROM (
         SELECT workspace_id, doc_key, ordinal, embedding FROM chunks
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
          `SELECT matches.workspace_id AS workspaceId,
             matches.doc_key AS docKey, matches.ordinal AS ordinal
           FROM (
             SELECT workspace_id, doc_key, ordinal, count() AS matched
             FROM (${termMatches})
             GROUP BY workspace_id, doc_key, ordinal
           ) AS matches
           INNER JOIN (
             SELECT workspace_id, doc_key, title FROM documents
             WHERE ${inWorkspaces}
           ) AS documents
             ON documents.workspace_id = matches.workspace_id
             AND documents.doc_key = matches.doc_key
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
    selectIn<DocumentRecord & { workspaceId: string }>(
      client,
      scope,
      `SELECT workspace_id AS workspaceId, ${documentColumns} FROM documents
       WHERE ${inWorkspaces} AND status = 'active'
         AND (workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}`,
      {
        refs: refTuples(top),
      },
    ),
    selectIn<ChunkKey & ChunkLines>(
      client,
      scope,
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, ordinal, text,
         start_line AS startLine, end_line AS endLine
       FROM chunks WHERE ${inWorkspaces}
         AND (workspace_id, doc_key, ordinal) IN {keys:Array(Tuple(String, String, UInt32))}`,
      {
        keys: top.map(
          (hit) => new TupleParam([hit.workspaceId, hit.docKey, hit.ordinal]),
        ),
      },
    ),
  ])
  const documentById = new Map(
    documents.map(({ workspaceId, ...record }) => [
      documentId({ workspaceId, docKey: record.docKey }),
      record,
    ]),
  )
  const textById = new Map(texts.map((row) => [chunkId(row), row]))
  const hits = new Map<string, SearchHit>()
  for (const chunk of top) {
    const id = documentId(chunk)
    const record = documentById.get(id)
    // A document that changed after the first query is not a hit.
    if (!record) continue
    const hit = hits.get(id) ?? {
      workspaceId: chunk.workspaceId,
      document: toDocument(record),
      chunks: [],
    }
    const found = textById.get(chunkId(chunk))
    hit.chunks.push({
      ordinal: chunk.ordinal,
      text: found?.text ?? "",
      startLine: found?.startLine ?? 0,
      endLine: found?.endLine ?? 0,
      score: chunk.score,
    })
    hits.set(id, hit)
  }
  return [...hits.values()]
}

/**
 * The reference keys of `doc_refs` that pass `where`, each as the relation
 * target that names it (`ref:<key>`), with its document. The frontier read
 * and the graph read find the documents of a key target with it.
 */
const keyTargets = (where: string) =>
  `SELECT workspace_id, concat({prefix:String}, ref_key) AS target, doc_key
   FROM doc_refs WHERE ${where}`

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
 * (sorted by `dst_doc`). Each relation has the document row of its neighbor,
 * or `null` when the neighbor has no row. With `validAt`, a relation or a
 * neighbor that is not valid at that time is not returned.
 *
 * A relation to a reference key resolves through `doc_refs` (ADR-066
 * decision 5): an out-relation comes one time for each document of the key,
 * else one time with a `missing` neighbor; an in-relation to a key of a
 * frontier document has that document as `dstDoc`. Two keys of one target
 * give one relation when all its fields are the same.
 */
async function readFrontier(
  client: ClickHouseClient,
  scope: KnowledgeReadScope,
  refs: DocumentRef[],
  validAtTime: Date | null = null,
): Promise<FrontierRelation[]> {
  assertReadScope(scope)
  if (refs.length === 0) return []
  // relations_in has the columns of relations, sorted by dst_doc. A UNION
  // ALL takes the columns of each branch in this order.
  const edgeColumns = `workspace_id, src_doc, src_chunk, predicate, dst_doc,
    confidence, valid_from, valid_to, source, alt_text, observed_at`
  const isKey = (column: string) => `startsWith(${column}, {prefix:String})`
  const rows = await selectIn<
    RelationRecord & {
      direction: "out" | "in"
      workspaceId: string
      neighbor: DocumentRecord
    }
  >(
    client,
    scope,
    `WITH out_edges AS (
       SELECT ${edgeColumns} FROM relations
       WHERE ${inWorkspaces}
         AND (workspace_id, src_doc) IN {refs:Array(Tuple(String, String))}
         AND ${validDuring()}
     ),
     own_keys AS (
       ${keyTargets(`${inWorkspaces}
         AND (workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}`)}
     ),
     edges AS (
       SELECT 'out' AS direction, dst_doc AS neighbor_doc, ${edgeColumns}
       FROM out_edges WHERE NOT ${isKey("dst_doc")}
       UNION ALL
       SELECT 'out', ${resolvedTarget("o")},
         o.workspace_id, o.src_doc, o.src_chunk, o.predicate,
         ${resolvedTarget("o")}, o.confidence,
         o.valid_from, o.valid_to, o.source, o.alt_text, o.observed_at
       FROM out_edges AS o
       LEFT JOIN (
         ${keyTargets(`${inWorkspaces} AND ref_key IN (
           SELECT substring(dst_doc, length({prefix:String}) + 1)
           FROM out_edges WHERE ${isKey("dst_doc")})`)}
       ) AS keys
         ON keys.workspace_id = o.workspace_id AND keys.target = o.dst_doc
       WHERE ${isKey("o.dst_doc")}
       UNION ALL
       SELECT 'in', src_doc, ${edgeColumns}
       FROM relations_in
       WHERE ${inWorkspaces}
         AND (workspace_id, dst_doc) IN {refs:Array(Tuple(String, String))}
         AND ${validDuring()}
       UNION ALL
       SELECT 'in', i.src_doc, i.workspace_id, i.src_doc, i.src_chunk,
         i.predicate, k.doc_key, i.confidence, i.valid_from, i.valid_to,
         i.source, i.alt_text, i.observed_at
       FROM relations_in AS i
       INNER JOIN own_keys AS k
         ON k.workspace_id = i.workspace_id AND k.target = i.dst_doc
       WHERE i.org_id = {orgId:String}
         AND i.workspace_id IN {workspaceIds:Array(String)}
         AND (i.workspace_id, i.dst_doc) IN (
           SELECT workspace_id, target FROM own_keys)
         AND ${validDuring("i.")}
     )
     SELECT DISTINCT edges.direction AS direction,
       edges.workspace_id AS workspaceId,
       edges.src_doc AS srcDoc, edges.src_chunk AS srcChunk,
       edges.predicate AS predicate, edges.dst_doc AS dstDoc,
       edges.confidence AS confidence, edges.valid_from AS validFrom,
       edges.valid_to AS validTo, edges.source AS source,
       edges.alt_text AS altText,
       edges.observed_at AS observedAt, neighbors.document AS neighbor
     FROM edges
     LEFT JOIN (
       SELECT workspace_id, doc_key, valid_from, valid_to,
         tuple(${documentColumns}) AS document
       FROM documents
       WHERE ${inWorkspaces} AND (workspace_id, doc_key) IN (
         SELECT workspace_id, neighbor_doc FROM edges)
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
  return rows.map(({ direction, workspaceId, neighbor, ...relation }) => ({
    direction,
    workspaceId,
    relation: toRelation(relation),
    // Without a match, the LEFT JOIN gives a tuple of default values. A
    // reference key with no document is a `missing` target.
    neighbor: neighbor.docKey
      ? toDocument(neighbor)
      : relation.dstDoc.startsWith(REFERENCE_TARGET_PREFIX)
        ? emptyDocument(
            relation.dstDoc,
            "missing",
            new Date(relation.observedAt),
          )
        : null,
  }))
}

/** The document row of each of `refs` that has one, in one query. */
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
    `SELECT workspace_id AS workspaceId, ${documentColumns} FROM documents
     WHERE ${inWorkspaces}
       AND (workspace_id, doc_key) IN {refs:Array(Tuple(String, String))}
     ORDER BY workspaceId, docKey`,
    { refs: refTuples(refs) },
  )
  return rows.map(({ workspaceId, ...record }) => ({
    workspaceId,
    document: toDocument(record),
  }))
}

/**
 * The evidence of the documents `refs`: each document row with its
 * `chunksPerDocument` chunks closest to `vector` (cosine distance).
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
      `SELECT workspace_id AS workspaceId, ${documentColumns} FROM documents
       WHERE ${inWorkspaces} AND ${inRefs}`,
      params,
    ),
    selectIn<ChunkKey & ChunkLines & { distance: number }>(
      client,
      scope,
      `SELECT workspace_id AS workspaceId, doc_key AS docKey, ordinal, text,
         start_line AS startLine, end_line AS endLine,
         cosineDistance(embedding, {queryVector:Array(Float32)}) AS distance
       FROM chunks WHERE ${inWorkspaces} AND ${inRefs}
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
 * The documents and the relations of one Workspace for the graph view, each
 * list cut at `limit` rows. `truncated` is true when a list was cut.
 */
async function readGraph(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  limit: number,
): Promise<KnowledgeGraph> {
  const params = { limit: limit + 1 }
  const [documents, relations] = await Promise.all([
    select<DocumentRecord>(
      client,
      scope,
      `SELECT ${documentColumns} FROM documents WHERE ${scoped}
       ORDER BY doc_key LIMIT {limit:UInt32}`,
      params,
    ),
    // A relation to a reference key gets the documents of the key
    // (ADR-066 decision 5). Two keys of one target give one relation when
    // all its fields are the same.
    select<RelationRecord>(
      client,
      scope,
      `SELECT DISTINCT rel.src_doc AS srcDoc, rel.src_chunk AS srcChunk,
         rel.predicate AS predicate, ${resolvedTarget("rel")} AS dstDoc,
         rel.confidence AS confidence, rel.valid_from AS validFrom,
         rel.valid_to AS validTo, rel.source AS source,
         rel.alt_text AS altText, rel.observed_at AS observedAt
       FROM (
         SELECT src_doc, src_chunk, predicate, dst_doc, confidence,
           valid_from, valid_to, source, alt_text, observed_at
         FROM relations WHERE ${scoped}
       ) AS rel
       LEFT JOIN (${keyTargets(scoped)}) AS keys
         ON keys.target = rel.dst_doc
       ORDER BY srcDoc, srcChunk, predicate, dstDoc
       LIMIT {limit:UInt32}`,
      { ...params, prefix: REFERENCE_TARGET_PREFIX },
    ),
  ])
  return {
    documents: documents.slice(0, limit).map(toDocument),
    relations: relations.slice(0, limit).map(toRelation),
    truncated: documents.length > limit || relations.length > limit,
  }
}

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
