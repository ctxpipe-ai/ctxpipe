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

/** The rows of one document: the relations that it states are its own. */
export type DocumentRows = {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  relations: Omit<KnowledgeRelation, "srcDoc">[]
}

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
 * function takes the org and the Workspace, and each statement has two org
 * walls:
 * - Reads: `org_id` and `workspace_id` are in the WHERE clause, and the row
 *   policy filters to the org of {@link ORG_SETTING}.
 * - Inserts: this module sets `org_id` and `workspace_id` of each row from
 *   the scope, and the CHECK constraint refuses a row of another org.
 */
type KnowledgeStore = {
  insertDocument(scope: KnowledgeScope, rows: DocumentRows): Promise<void>
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
    insertDocument: (scope, rows) => insertDocument(client, scope, rows),
    readDocument: (scope, docKey) => readDocument(client, scope, docKey),
    close: () => client.close(),
  }
}

function assertScope(scope: KnowledgeScope): void {
  if (!scope.orgId || !scope.workspaceId)
    throw new Error("A knowledge statement needs an org and a Workspace")
}

/** The columns of each table, as an insert sends them. */
type ScopeColumns = { org_id: string; workspace_id: string }
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
  relations: ScopeColumns & {
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
}

async function insertDocument(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  { document, chunks, relations }: DocumentRows,
): Promise<void> {
  assertScope(scope)
  // The insert wall of this module: each row is made field by field, and the
  // org and Workspace columns come only from the scope. A value that a caller
  // puts in a row does not get into the insert.
  const owner: ScopeColumns = {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
  }
  const insert = <T extends keyof TableRows>(
    table: T,
    values: TableRows[T][],
  ) =>
    client.insert({
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
  await insert("documents", [
    {
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
    },
  ])
  if (chunks.length > 0)
    await insert(
      "chunks",
      chunks.map((chunk) => ({
        ...owner,
        doc_key: document.docKey,
        ordinal: chunk.ordinal,
        text: chunk.text,
        embedding: chunk.embedding,
      })),
    )
  if (relations.length > 0)
    await insert(
      "relations",
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
}

const relationColumns = `src_doc AS srcDoc, src_chunk AS srcChunk, predicate,
  dst_doc AS dstDoc, confidence, valid_from AS validFrom, valid_to AS validTo,
  source, observed_at AS observedAt`

async function readDocument(
  client: ClickHouseClient,
  scope: KnowledgeScope,
  docKey: string,
): Promise<StoredDocument | null> {
  assertScope(scope)
  const select = async <T>(query: string) =>
    (
      await client.query({
        query,
        query_params: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          docKey,
        },
        format: "JSONEachRow",
        clickhouse_settings: {
          [ORG_SETTING]: scope.orgId,
          date_time_output_format: "iso",
        },
      })
    ).json<T>()
  const scoped =
    "org_id = {orgId:String} AND workspace_id = {workspaceId:String}"
  const [documents, chunks, outgoing, incoming] = await Promise.all([
    select<DocumentRecord>(
      `SELECT doc_key AS docKey, kind, status, deleted_at AS deletedAt, error,
         title, path, source_type AS sourceType, source, summary,
         s3_key AS s3Key, mime, valid_from AS validFrom, valid_to AS validTo,
         observed_at AS observedAt
       FROM documents WHERE ${scoped} AND doc_key = {docKey:String}`,
    ),
    select<KnowledgeChunk>(
      `SELECT ordinal, text, embedding FROM chunks
       WHERE ${scoped} AND doc_key = {docKey:String} ORDER BY ordinal`,
    ),
    select<RelationRecord>(
      `SELECT ${relationColumns} FROM relations
       WHERE ${scoped} AND src_doc = {docKey:String}
       ORDER BY src_chunk, predicate, dst_doc`,
    ),
    select<RelationRecord>(
      `SELECT ${relationColumns} FROM relations
       WHERE ${scoped} AND dst_doc = {docKey:String}
       ORDER BY src_doc, src_chunk, predicate`,
    ),
  ])
  const [document] = documents
  if (!document) return null
  return {
    document: {
      ...document,
      deletedAt: toDate(document.deletedAt),
      validFrom: toDate(document.validFrom),
      validTo: toDate(document.validTo),
      observedAt: new Date(document.observedAt),
    },
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

const toRelation = (relation: RelationRecord): KnowledgeRelation => ({
  ...relation,
  validFrom: toDate(relation.validFrom),
  validTo: toDate(relation.validTo),
  observedAt: new Date(relation.observedAt),
})
