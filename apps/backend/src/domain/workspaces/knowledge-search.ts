import { type SQL, sql } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { log } from "../../observability/logger.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"

type KnowledgeSearchInput = {
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
   * A bound is a time only when it starts with `YYYY-MM-DD`. Any other value
   * (for example a Git SHA that hydrate has not yet rewritten) is no bound.
   */
  validAt?: Date
  /** Only these units (for example the units that a graph walk explored). */
  unitIds?: readonly string[]
  /** Default 10, at most 50. */
  limit?: number
  /** Monotonic deadline shared by all work in a related-unit call. */
  deadline?: number
  /**
   * The embedding of `query` (`embedQuery`), so that a caller that searches
   * the same query more than once embeds it once. With none, the search
   * embeds the query.
   */
  embedding?: Promise<number[] | null>
}

/** The best chunk of one unit. */
type KnowledgeHit = {
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
  /** The claims of the unit. Front matter can hold facts that no chunk states. */
  claims: Array<{ predicate: string | null; to: string }>
  /** Reciprocal rank fusion score of the chunk. */
  score: number
}

// Each ranking keeps this many chunks before the fusion. It is also the HNSW
// candidate list, so a unit with many close chunks cannot push out the others.
const CANDIDATES = 100
const RRF_K = 60

/**
 * Settings of one filtered HNSW scan. From pgvector 0.8 the scan goes on
 * until it has enough rows. Before that, only a longer candidate list helps.
 * The version of the `vector` extension is the input.
 */
export function vectorScanSettings(version: string | null): {
  iterativeScan: boolean
  efSearch: number
} {
  const [major, minor] = (version ?? "").split(".").map(Number)
  const iterativeScan =
    major !== undefined &&
    minor !== undefined &&
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    (major > 0 || minor >= 8)
  // 1,000 is the largest value that pgvector accepts for `hnsw.ef_search`.
  return { iterativeScan, efSearch: iterativeScan ? CANDIDATES : 1000 }
}

let pgvectorVersion: string | null | undefined

/**
 * Hybrid knowledge search over the chunks of the active projection (ADR-051):
 * full-text and vector rankings fuse with reciprocal rank fusion in one SQL
 * statement. Returns the best chunk of each unit, best first.
 */
export async function searchKnowledge(
  input: KnowledgeSearchInput,
): Promise<KnowledgeHit[]> {
  if (input.deadline === undefined) return runSearch(input)
  const remaining = input.deadline - performance.now()
  if (remaining <= 0)
    throw new DOMException("Search deadline reached", "TimeoutError")
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      runSearch(input, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException(
            "Search deadline reached",
            "TimeoutError",
          )
          controller.abort(error)
          reject(error)
        }, remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The embedding of a search query, or null when the model call fails: the
 * search then uses full text only. An abort of `signal` rejects.
 */
export async function embedQuery(
  query: string,
  signal?: AbortSignal,
): Promise<number[] | null> {
  try {
    return await generateEmbedding(query.trim(), signal)
  } catch (error) {
    signal?.throwIfAborted()
    log.warn({
      step: "knowledge-search-embed",
      message: `Query embedding failed; the search uses full text only: ${String(error)}`,
    })
    return null
  }
}

async function runSearch(
  input: KnowledgeSearchInput,
  signal?: AbortSignal,
): Promise<KnowledgeHit[]> {
  signal?.throwIfAborted()
  const query = input.query.trim()
  if (!query || input.workspaceIds.length === 0 || input.unitIds?.length === 0)
    return []
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 50)
  const embedding = await (input.embedding ?? embedQuery(query, signal))
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
    const bound = (key: "validFrom" | "validTo") =>
      sql.raw(
        `(CASE WHEN cl->>'${key}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND pg_input_is_valid(cl->>'${key}', 'timestamptz') THEN (cl->>'${key}')::timestamptz END)`,
      )
    const windowed = sql`(${bound("validFrom")} IS NOT NULL OR ${bound("validTo")} IS NOT NULL)`
    const at = sql`${input.validAt.toISOString()}::timestamptz`
    filters.push(sql`(
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(u.claims) AS cl WHERE ${windowed}
      ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(u.claims) AS cl
        WHERE ${windowed}
          AND coalesce(${bound("validFrom")} <= ${at}, true)
          AND coalesce(${bound("validTo")} > ${at}, true)
      ))`)
  }
  const where = sql.join(filters, sql` AND `)
  // Every ordering ends with the chunk key, so ties give the same rows and
  // ranks on each run, and the candidate cut falls the same way.
  const tieBreak = sql`c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence`

  const rows = await withOrgDbContext(input.orgId, async (db) => {
    signal?.throwIfAborted()
    const setTimeBudget = async () => {
      if (input.deadline === undefined) return
      signal?.throwIfAborted()
      const remaining = Math.ceil(input.deadline - performance.now())
      if (remaining <= 0)
        throw new DOMException("Search deadline reached", "TimeoutError")
      await db.execute(
        sql`SELECT set_config('statement_timeout', ${String(remaining)}, true)`,
      )
    }
    await setTimeBudget()
    // Dates without an offset are UTC, as in claim-confidence.ts.
    await db.execute(sql`SELECT set_config('TimeZone', 'UTC', true)`)
    let semantic = sql`SELECT NULL::text, NULL::text, NULL::text, NULL::int, NULL::bigint WHERE false`
    if (embedding) {
      const vector = sql`${JSON.stringify(embedding)}::vector`
      // The HNSW index is shared by all orgs. A scan stops after
      // `hnsw.max_scan_tuples` (20,000 by default) tuples, so a selective
      // filter can lose every hit. A small scope is cheaper to scan exactly.
      // 10,000 chunks of 2,000 dimensions take about 100 milliseconds.
      const counted = await db.execute<{ count: number | string }>(
        sql`SELECT count(*) AS count FROM (
          SELECT 1 FROM ${scope} WHERE ${where} AND c.embedding IS NOT NULL LIMIT 10001
        ) AS capped`,
      )
      if (Number(counted.rows[0]?.count) <= 10_000) {
        // MATERIALIZED keeps the planner from walking the HNSW index.
        semantic = sql`WITH scoped AS MATERIALIZED (
            SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
              c.embedding <=> ${vector} AS distance
            FROM ${scope}
            WHERE ${where} AND c.embedding IS NOT NULL
          )
          SELECT ${tieBreakOuter},
            row_number() OVER (ORDER BY distance, ${tieBreakOuter}) AS rank
          FROM (
            SELECT * FROM scoped ORDER BY distance, ${tieBreakOuter} LIMIT ${CANDIDATES}
          ) AS nearest`
      } else {
        if (pgvectorVersion === undefined) {
          const found = await db.execute<{ version: string }>(
            sql`SELECT extversion AS version FROM pg_extension WHERE extname = 'vector'`,
          )
          pgvectorVersion = found.rows[0]?.version ?? null
        }
        const settings = vectorScanSettings(pgvectorVersion)
        await db.execute(
          sql`SELECT set_config('hnsw.ef_search', ${String(settings.efSearch)}, true)`,
        )
        if (settings.iterativeScan)
          await db.execute(
            sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
          )
        semantic = hnswCandidates(vector, where)
      }
    }
    await setTimeBudget()
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
      claims: Array<{ predicate: string | null; to: string }>
      score: number | string
    }>(sql`
      WITH q AS (
        SELECT plainto_tsquery('english', ${query}) AS every_term,
          replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery AS any_term
      ),
      lexical AS (
        SELECT ${tieBreakOuter},
          row_number() OVER (ORDER BY every_match DESC, text_rank DESC, ${tieBreakOuter}) AS rank
        FROM (
          SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
            c.search @@ q.every_term AS every_match,
            ts_rank_cd(c.search, q.any_term) AS text_rank
          FROM ${scope}, q
          WHERE ${where} AND c.search @@ q.any_term
          ORDER BY every_match DESC, text_rank DESC, ${tieBreak}
          LIMIT ${CANDIDATES}
        ) AS matched
      ),
      semantic AS (${semantic}),
      fused AS (
        SELECT ${tieBreakOuter},
          sum(1.0 / (${RRF_K} + rank)) AS score
        FROM (SELECT * FROM lexical UNION ALL SELECT * FROM semantic) AS ranked
        GROUP BY ${tieBreakOuter}
      ),
      best AS (
        SELECT DISTINCT ON (workspace_id, unit_id) *
        FROM fused
        ORDER BY workspace_id, unit_id, score DESC, occurrence, chunk_hash
      )
      SELECT b.workspace_id, b.unit_id, u.path, u.kind, u.title,
        coalesce(u.source, 'authored') AS source, u.updated_at, u.projection_sha,
        c.start_line, c.end_line, c.text, coalesce(u.claims, '[]'::jsonb) AS claims, b.score
      FROM best AS b
      JOIN workspace_knowledge_chunks AS c
        ON c.workspace_id = b.workspace_id AND c.unit_id = b.unit_id
        AND c.chunk_hash = b.chunk_hash AND c.occurrence = b.occurrence
      JOIN workspace_knowledge_units AS u
        ON u.workspace_id = b.workspace_id AND u.serving_id = b.unit_id
      ORDER BY b.score DESC, u.path, b.workspace_id, b.unit_id
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
    claims: row.claims.map(({ predicate, to }) => ({ predicate, to })),
    score: Number(row.score),
  }))
}

const scope = sql`workspace_knowledge_chunks AS c
    JOIN workspace_knowledge_units AS u
      ON u.workspace_id = c.workspace_id AND u.serving_id = c.unit_id
    JOIN workspaces AS w ON w.id = c.workspace_id`
const tieBreakOuter = sql`workspace_id, unit_id, chunk_hash, occurrence`

/** The nearest chunks of a large scope, read through the HNSW index. */
export function hnswCandidates(vector: SQL, where: SQL): SQL {
  // `relaxed_order` can return rows a little out of order. The outer
  // `row_number()` sorts them again by distance and then by the key.
  // Only a bare `ORDER BY distance` lets the planner use the HNSW
  // index, so the key breaks ties in the rank window, not here.
  return sql`SELECT ${tieBreakOuter},
      row_number() OVER (ORDER BY distance, ${tieBreakOuter}) AS rank
    FROM (
      SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
        c.embedding <=> ${vector} AS distance
      FROM ${scope}
      WHERE ${where} AND c.embedding IS NOT NULL
      ORDER BY distance
      LIMIT ${CANDIDATES}
    ) AS nearest`
}

function textArray(values: readonly string[]): SQL {
  return sql`${sql.param(values)}::text[]`
}
