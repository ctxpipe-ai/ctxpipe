import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  createClient,
} from "@clickhouse/client"

/**
 * The per-query custom setting that holds the org of a statement. The row
 * policy and the CHECK constraint of each knowledge table compare `org_id`
 * with it (migrations/0001_knowledge_tables.sql).
 */
export const ORG_SETTING = "SQL_ctxpipe_org_id"

/** The org and the Workspace of each statement. */
export type KnowledgeScope = { orgId: string; workspaceId: string }

type DocumentStatus = "active" | "deleted" | "missing" | "failed"

type KnowledgeDocument = {
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
  s3Key: string
  mime: string
  validFrom: Date | null
  validTo: Date | null
  observedAt: Date
}

export type KnowledgeChunk = {
  ordinal: number
  text: string
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

type StoredDocument = {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  /** The relations that this document states. */
  outgoing: KnowledgeRelation[]
  /** The relations of other documents (and this one) that point at it. */
  incoming: KnowledgeRelation[]
}

/**
 * The only ClickHouse client of the knowledge content (ADR-066). Each
 * function takes the org and the Workspace, and each statement has org walls:
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
 * decision 8). Each mutation takes a batch, because each DELETE is a
 * mutation of the table. A retry after a failure is safe (ADR-067
 * decision 5).
 */
type KnowledgeStore = {
  /**
   * Replaces the state of each document: deletes its document, chunk and
   * outgoing relation rows, then inserts the new rows with status `active`.
   */
  replaceDocuments(
    scope: KnowledgeScope,
    documents: DocumentRows[],
  ): Promise<void>
  /**
   * Makes a tombstone of each document (ADR-067 decision 6): status
   * `deleted` and `deletedAt`, with the other fields of its row. Deletes its
   * chunks and outgoing relations. The relations of other documents that
   * point at it stay. A key with no row gets a tombstone with empty fields,
   * so a retry after a failure between the DELETE and the INSERT still
   * makes the tombstone.
   */
  markDeleted(
    scope: KnowledgeScope,
    docKeys: string[],
    deletedAt: Date,
  ): Promise<void>
  /**
   * Replaces the state of each document with a placeholder row, with no
   * chunks and no outgoing relations.
   */
  insertPlaceholders(
    scope: KnowledgeScope,
    placeholders: Placeholder[],
  ): Promise<void>
  /** The key and the status of each document of the Workspace. */
  listDocumentKeys(
    scope: KnowledgeScope,
  ): Promise<{ docKey: string; status: DocumentStatus }[]>
  readDocument(
    scope: KnowledgeScope,
    docKey: string,
  ): Promise<StoredDocument | null>
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
    replaceDocuments: (scope, documents) =>
      replaceDocuments(client, scope, documents),
    markDeleted: (scope, docKeys, deletedAt) =>
      markDeleted(client, scope, docKeys, deletedAt),
    insertPlaceholders: (scope, placeholders) =>
      insertPlaceholders(client, scope, placeholders),
    listDocumentKeys: (scope) => listDocumentKeys(client, scope),
    readDocument: (scope, docKey) => readDocument(client, scope, docKey),
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

/**
 * Deletes the chunks and the outgoing relations of each document, from
 * `relations` and from `relations_in`.
 */
async function deleteContent(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKeys: string[],
): Promise<void> {
  // relations_in sorts by dst_doc. Its DELETE filters by the targets of the
  // documents, which relations gives, so that it uses the sort key
  // (CTX-1391).
  const targets = await select<{ dstDoc: string }>(
    client,
    scope,
    `SELECT DISTINCT dst_doc AS dstDoc FROM relations
     WHERE ${scoped} AND src_doc IN {docKeys:Array(String)}`,
    { docKeys },
  )
  await deleteWhere(
    client,
    scope,
    "chunks",
    "doc_key IN {docKeys:Array(String)}",
    { docKeys },
  )
  // relations_in first: while a row stays in relations, a retry after a
  // failure finds its target again.
  if (targets.length > 0)
    await deleteWhere(
      client,
      scope,
      "relations_in",
      "dst_doc IN {dstDocs:Array(String)} AND src_doc IN {docKeys:Array(String)}",
      { docKeys, dstDocs: targets.map((target) => target.dstDoc) },
    )
  await deleteWhere(
    client,
    scope,
    "relations",
    "src_doc IN {docKeys:Array(String)}",
    { docKeys },
  )
}

type StoredRows = Omit<DocumentRows, "document"> & {
  document: KnowledgeDocument
}

/** Deletes all rows of each document, then inserts `rows`. */
async function replaceRows(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  rows: StoredRows[],
): Promise<void> {
  assertScope(scope)
  if (rows.length === 0) return
  const docKeys = rows.map((row) => row.document.docKey)
  if (new Set(docKeys).size !== docKeys.length)
    throw new Error("A batch has the same document key two times")
  await deleteContent(client, scope, docKeys)
  await deleteWhere(
    client,
    scope,
    "documents",
    "doc_key IN {docKeys:Array(String)}",
    { docKeys },
  )
  await insertRows(client, scope, rows)
}

const replaceDocuments = (
  client: ClickHouseClient,
  scope: KnowledgeScope,
  documents: DocumentRows[],
) =>
  replaceRows(
    client,
    scope,
    documents.map(({ document, chunks, relations }) => ({
      document: { ...document, status: "active", deletedAt: null, error: "" },
      chunks,
      relations,
    })),
  )

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
  s3Key: "",
  mime: "",
  validFrom: null,
  validTo: null,
  observedAt,
})

/** The stored document row of each key that has one. */
async function storedDocuments(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKeys: string[],
): Promise<Map<string, KnowledgeDocument>> {
  const records = await select<DocumentRecord>(
    client,
    scope,
    `SELECT ${documentColumns} FROM documents
     WHERE ${scoped} AND doc_key IN {docKeys:Array(String)}`,
    { docKeys },
  )
  return new Map(records.map((record) => [record.docKey, toDocument(record)]))
}

async function insertPlaceholders(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  placeholders: Placeholder[],
): Promise<void> {
  // A `missing` row is only for a key with no row (ADR-067 decision 7). It
  // never replaces a document or a tombstone. A `failed` row replaces the
  // state of its document.
  const stored = await storedDocuments(
    client,
    scope,
    placeholders
      .filter((placeholder) => placeholder.status === "missing")
      .map((placeholder) => placeholder.docKey),
  )
  await replaceRows(
    client,
    scope,
    placeholders
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
  )
}

async function markDeleted(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKeys: string[],
  deletedAt: Date,
): Promise<void> {
  const stored = await storedDocuments(client, scope, docKeys)
  await replaceRows(
    client,
    scope,
    [...new Set(docKeys)].map((docKey) => {
      const document =
        stored.get(docKey) ?? emptyDocument(docKey, "deleted", deletedAt)
      return {
        document: {
          ...document,
          status: "deleted",
          // A tombstone keeps the date of the first deletion, also after a
          // retry or the reconcile of a full rebuild.
          deletedAt:
            document.status === "deleted" && document.deletedAt
              ? document.deletedAt
              : deletedAt,
          error: "",
        },
        chunks: [],
        relations: [],
      }
    }),
  )
}

const listDocumentKeys = (client: ClickHouseClient, scope: KnowledgeScope) =>
  select<{ docKey: string; status: DocumentStatus }>(
    client,
    scope,
    `SELECT doc_key AS docKey, status FROM documents WHERE ${scoped}
     ORDER BY doc_key`,
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
    s3_key: string
    mime: string
    valid_from: string | null
    valid_to: string | null
    observed_at: string
  }
  chunks: ScopeColumns & {
    doc_key: string
    ordinal: number
    text: string
    embedding: number[]
  }
  relations: RelationColumns
  relations_in: RelationColumns
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
      s3_key: document.s3Key,
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
      observed_at: relation.observedAt.toISOString(),
    })),
  )
  // relations first: deleteContent finds the rows of relations_in through
  // relations, so a failure between the two inserts leaves no row that a
  // retry cannot find.
  await insert("relations", relations)
  await insert("relations_in", relations)
}

const documentColumns = `doc_key AS docKey, kind, status,
  deleted_at AS deletedAt, error, title, path, source_type AS sourceType,
  source, summary, s3_key AS s3Key, mime, valid_from AS validFrom,
  valid_to AS validTo, observed_at AS observedAt`

const relationColumns = `src_doc AS srcDoc, src_chunk AS srcChunk, predicate,
  dst_doc AS dstDoc, confidence, valid_from AS validFrom, valid_to AS validTo,
  source, observed_at AS observedAt`

async function readDocument(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKey: string,
): Promise<StoredDocument | null> {
  const params = { docKey }
  const [documents, chunks, outgoing, incoming] = await Promise.all([
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
      `SELECT ordinal, text, embedding FROM chunks
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
  ])
  const [document] = documents
  if (!document) return null
  return {
    document: toDocument(document),
    chunks,
    outgoing: outgoing.map(toRelation),
    incoming: incoming.map(toRelation),
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
