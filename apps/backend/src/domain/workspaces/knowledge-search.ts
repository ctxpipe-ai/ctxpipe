import { type SQL, sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"

export type KnowledgeSearchInput = {
  orgId: string
  /** Workspaces of `orgId` to search. Row-level security hides other orgs. */
  workspaceIds: readonly string[]
  query: string
  kinds?: readonly string[]
  /** Literal path prefix (no pattern characters). */
  pathPrefix?: string
  /** Connector mirror roots, or `authored`. */
  sources?: readonly string[]
  updatedAfter?: Date
  /**
   * A unit matches when it has no claim with a validity window, or when at
   * least one such claim covers this time (`validFrom` ≤ T < `validTo`).
   */
  validAt?: Date
  /** Only these units (for example the units that a graph walk explored). */
  unitIds?: readonly string[]
  /** Default 10, at most 50. */
  limit?: number
  /** Embeds the query. A failure gives lexical results only. */
  embedQuery?: (query: string) => Promise<number[]>
}

/** The best chunk of one unit. */
export type KnowledgeHit = {
  workspaceId: string
  unitId: string
  path: string
  kind: string | null
  title: string | null
  source: string
  updatedAt: Date
  projectionSha: string
  /** 1-based file lines of the chunk, inclusive. */
  startLine: number
  endLine: number
  /** Title and heading path, then the section text. */
  text: string
  /** Reciprocal rank fusion score of the chunk. */
  score: number
}

// Each ranking keeps this many chunks before the fusion. It is also the HNSW
// candidate list, so a unit with many close chunks cannot push out the others.
const CANDIDATES = 100
const RRF_K = 60

/**
 * Hybrid knowledge search over the chunks of the active projection (ADR-051):
 * full-text and vector rankings fuse with reciprocal rank fusion in one SQL
 * statement. Returns the best chunk of each unit, best first.
 */
export async function searchKnowledge(
  input: KnowledgeSearchInput,
): Promise<KnowledgeHit[]> {
  const query = input.query.trim()
  if (!query || input.workspaceIds.length === 0 || input.unitIds?.length === 0)
    return []
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 50)
  let embedding: number[] | null = null
  try {
    embedding = await (input.embedQuery ?? generateEmbedding)(query)
  } catch (error) {
    log.warn({
      step: "knowledge-search-embed",
      message: `Query embedding failed; the search uses full text only: ${String(error)}`,
    })
  }
  const filters: SQL[] = [
    sql`c.workspace_id = ANY(${textArray(input.workspaceIds)})`,
    sql`u.projection_sha = coalesce(w.active_revision->>'sha', w.active_projection_sha)`,
  ]
  if (input.kinds?.length)
    filters.push(sql`u.kind = ANY(${textArray(input.kinds)})`)
  if (input.pathPrefix)
    filters.push(sql`starts_with(u.path, ${input.pathPrefix})`)
  if (input.sources?.length)
    filters.push(
      sql`coalesce(u.source, 'authored') = ANY(${textArray(input.sources)})`,
    )
  if (input.updatedAfter)
    filters.push(
      sql`u.updated_at > ${input.updatedAfter.toISOString()}::timestamptz`,
    )
  if (input.unitIds)
    filters.push(sql`u.serving_id = ANY(${textArray(input.unitIds)})`)
  if (input.validAt) {
    // ISO strings compare in time order, also for a date without a time.
    const at = input.validAt.toISOString()
    filters.push(sql`(
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(u.claims) AS cl
        WHERE cl->>'validFrom' IS NOT NULL OR cl->>'validTo' IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(u.claims) AS cl
        WHERE (cl->>'validFrom' IS NOT NULL OR cl->>'validTo' IS NOT NULL)
          AND coalesce(cl->>'validFrom' <= ${at}, true)
          AND coalesce(cl->>'validTo' > ${at}, true)
      ))`)
  }
  const where = sql.join(filters, sql` AND `)
  const scope = sql`workspace_knowledge_chunks AS c
    JOIN workspace_knowledge_units AS u
      ON u.workspace_id = c.workspace_id AND u.serving_id = c.unit_id
    JOIN workspaces AS w ON w.id = c.workspace_id`
  const semantic = embedding
    ? sql`SELECT workspace_id, unit_id, chunk_hash, occurrence,
          row_number() OVER (ORDER BY distance) AS rank
        FROM (
          SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
            c.embedding <=> ${JSON.stringify(embedding)}::vector AS distance
          FROM ${scope}
          WHERE ${where} AND c.embedding IS NOT NULL
          ORDER BY distance
          LIMIT ${CANDIDATES}
        ) AS nearest`
    : sql`SELECT NULL::text, NULL::text, NULL::text, NULL::int, NULL::bigint WHERE false`

  const rows = await withOrgDbContext(input.orgId, async (db) => {
    // Filtered HNSW scans continue until they have enough rows (pgvector 0.8).
    await db.execute(
      sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true),
        set_config('hnsw.ef_search', ${String(CANDIDATES)}, true)`,
    )
    const result = await db.execute<{
      workspace_id: string
      unit_id: string
      path: string
      kind: string | null
      title: string | null
      source: string
      updated_at: string | Date
      projection_sha: string
      start_line: number
      end_line: number
      text: string
      score: number | string
    }>(sql`
      WITH q AS (
        SELECT plainto_tsquery('english', ${query}) AS every_term,
          replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery AS any_term
      ),
      lexical AS (
        SELECT workspace_id, unit_id, chunk_hash, occurrence,
          row_number() OVER (ORDER BY every_match DESC, text_rank DESC) AS rank
        FROM (
          SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
            c.search @@ q.every_term AS every_match,
            ts_rank_cd(c.search, q.any_term) AS text_rank
          FROM ${scope}, q
          WHERE ${where} AND c.search @@ q.any_term
          ORDER BY every_match DESC, text_rank DESC
          LIMIT ${CANDIDATES}
        ) AS matched
      ),
      semantic AS (${semantic}),
      fused AS (
        SELECT workspace_id, unit_id, chunk_hash, occurrence,
          sum(1.0 / (${RRF_K} + rank)) AS score
        FROM (SELECT * FROM lexical UNION ALL SELECT * FROM semantic) AS ranked
        GROUP BY workspace_id, unit_id, chunk_hash, occurrence
      ),
      best AS (
        SELECT DISTINCT ON (workspace_id, unit_id) *
        FROM fused
        ORDER BY workspace_id, unit_id, score DESC, occurrence, chunk_hash
      )
      SELECT b.workspace_id, b.unit_id, u.path, u.kind, u.title,
        coalesce(u.source, 'authored') AS source, u.updated_at, u.projection_sha,
        c.start_line, c.end_line, c.text, b.score
      FROM best AS b
      JOIN workspace_knowledge_chunks AS c
        ON c.workspace_id = b.workspace_id AND c.unit_id = b.unit_id
        AND c.chunk_hash = b.chunk_hash AND c.occurrence = b.occurrence
      JOIN workspace_knowledge_units AS u
        ON u.workspace_id = b.workspace_id AND u.serving_id = b.unit_id
      ORDER BY b.score DESC, u.path, b.workspace_id
      LIMIT ${limit}
    `)
    return result.rows
  })
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    unitId: row.unit_id,
    path: row.path,
    kind: row.kind,
    title: row.title,
    source: row.source,
    updatedAt: new Date(row.updated_at),
    projectionSha: row.projection_sha,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: Number(row.score),
  }))
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`
}
