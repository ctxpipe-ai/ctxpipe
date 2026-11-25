import { type SQL, sql } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import {
  HALF_EMBEDDING,
  KNOWLEDGE_VECTOR_INDEX,
} from "../../db/schema/workspaces.js"
import { activeProjectionSha } from "../../models/workspaces.js"
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
export type KnowledgeHit = {
  workspaceId: string
  unitId: string
  path: string
  kind: string | null
  title: string | null
  source: string
  updatedAt: Date
  /** The SHA of the Workspace's active projection, which holds the unit. */
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
  /**
   * The plane only: Jev's p(states the answer), when the search asks it
   * (`statesAnswerAt` above 0, CTX-1685).
   */
  pStatesAnswer?: number
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
    // Each unit row belongs to the active projection of its Workspace.
    sql`c.workspace_id = ANY(${textArray(input.workspaceIds)})`,
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
      // The HNSW index is shared by all orgs, so a filtered walk reads the
      // vectors of other orgs until it has the scope's nearest: the smaller
      // the scope's share of the table, the more. An exact scan reads every
      // vector of the scope. Measured cold (evicted buffers, CTX-1380), they
      // cost the same at about 3% of the table; below that, and below 2,000
      // chunks, the exact scan reads less. At 3% a walk finds its 100 well
      // before `hnsw.max_scan_tuples` (20,000).
      // The exact scan: up to 2,000 chunks, or up to 3% of the table's
      // estimated rows, whichever is more; the count stops one above that.
      // Until the half-precision index is valid (migrate builds it
      // concurrently), every scope is scanned exactly, in full precision.
      const counted = await db.execute<{
        count: number | string
        exact_max: number | string
        hnsw_ready: boolean | null
      }>(
        sql`WITH cap AS (
          SELECT greatest(2000, ceil(0.03 * greatest(reltuples, 0)))::int AS exact_max
          FROM pg_class WHERE oid = 'workspace_knowledge_chunks'::regclass
        )
        SELECT (SELECT exact_max FROM cap) AS exact_max,
          (SELECT bool_and(i.indisvalid) FROM pg_index AS i JOIN pg_class AS ic ON ic.oid = i.indexrelid
            WHERE ic.relname = ${KNOWLEDGE_VECTOR_INDEX}) AS hnsw_ready,
          count(*) AS count FROM (
          SELECT 1 FROM ${scope} WHERE ${where} AND c.embedding IS NOT NULL
          LIMIT (SELECT exact_max + 1 FROM cap)
        ) AS capped`,
      )
      const first = counted.rows[0]
      if (
        first?.hnsw_ready !== true ||
        Number(first.count) <= Number(first.exact_max)
      ) {
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
        // Postgres does not count the reads of a TOASTed vector, so it
        // would compute the exact distance of every chunk in scope: about 15
        // times the cold reads of the walk. With sequential scans and sorts
        // off, only the HNSW index gives the order. They hold for this one
        // statement: the next ones of the transaction get the defaults back.
        await setTimeBudget()
        await db.execute(
          sql`SELECT set_config('enable_seqscan', 'off', true), set_config('enable_sort', 'off', true), set_config('enable_incremental_sort', 'off', true)`,
        )
        const nearest = await db.execute<{
          workspace_id: string
          unit_id: string
          chunk_hash: string
          occurrence: number
          rank: number | string
        }>(hnswCandidates(vector, where))
        await db.execute(
          sql`SELECT set_config('enable_seqscan', 'on', true), set_config('enable_sort', 'on', true), set_config('enable_incremental_sort', 'on', true)`,
        )
        semantic = sql`SELECT workspace_id, unit_id, chunk_hash, occurrence, rank
          FROM jsonb_to_recordset(${JSON.stringify(nearest.rows)}::jsonb)
            AS nearest(workspace_id text, unit_id text, chunk_hash text, occurrence int, rank bigint)`
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
      WITH lexical AS (${lexicalCandidates(query, input.workspaceIds, where)}),
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
        coalesce(u.source, 'authored') AS source, u.updated_at,
        ${activeProjectionSha("w")} AS projection_sha,
        c.start_line, c.end_line, c.text, coalesce(u.claims, '[]'::jsonb) AS claims, b.score
      FROM best AS b
      JOIN workspace_knowledge_chunks AS c
        ON c.workspace_id = b.workspace_id AND c.unit_id = b.unit_id
        AND c.chunk_hash = b.chunk_hash AND c.occurrence = b.occurrence
      JOIN workspace_knowledge_units AS u
        ON u.workspace_id = b.workspace_id AND u.serving_id = b.unit_id
      JOIN workspaces AS w ON w.id = b.workspace_id
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

/** Chunks as `c`, with their unit `u`, for the filters. */
function scopeOf(chunks: SQL): SQL {
  return sql`${chunks} AS c
    JOIN workspace_knowledge_units AS u
      ON u.workspace_id = c.workspace_id AND u.serving_id = c.unit_id`
}
const scope = scopeOf(sql`workspace_knowledge_chunks`)
const tieBreakOuter = sql`workspace_id, unit_id, chunk_hash, occurrence`

/**
 * The best full-text chunks of a scope, read through the GIN index. Under the
 * RLS policy of `workspace_knowledge_chunks`, Postgres does not use an index
 * for `@@`, because `@@` is not leakproof: `ctxpipe_app` read the tsvector of
 * every chunk in scope. The view `workspace_knowledge_chunk_search` has the
 * policy's org filter and no policy. When a query also reads a table with a
 * policy, Postgres does not use the index for `@@` either, so the match is a
 * materialized CTE of the view alone.
 *
 * The match runs once for each Workspace, with the org, the Workspace (a
 * constant) and the terms all conditions of `KNOWLEDGE_SEARCH_INDEX`: it reads only the matches
 * of the scope, not those of the whole org (CTX-1380). It keeps their keys;
 * the ranking reads the tsvector of the matches that pass the other filters.
 */
export function lexicalCandidates(
  query: string,
  workspaceIds: readonly string[],
  where: SQL,
): SQL {
  // Inline, not a CTE of its own: with a constant tsquery, the planner
  // estimates the match from the index statistics.
  const everyTerm = sql`plainto_tsquery('english', ${query})`
  const anyTerm = sql`replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery`
  // Every ordering ends with the chunk key, so ties give the same rows and
  // ranks on each run, and the candidate cut falls the same way.
  const tieBreak = sql`c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence`
  // One scan for each Workspace, its id a constant, so that the GIN index
  // always takes it as a condition (a joined id it may leave to a filter).
  const scans = sql.join(
    workspaceIds.map(
      (id) => sql`SELECT v.workspace_id, v.unit_id, v.chunk_hash, v.occurrence
        FROM workspace_knowledge_chunk_search AS v
        WHERE (v.workspace_id COLLATE "C") = (${id}::text COLLATE "C")
          AND v.search @@ ${anyTerm}`,
    ),
    sql` UNION ALL `,
  )
  return sql`WITH matched AS MATERIALIZED (${scans})
    SELECT ${tieBreakOuter},
      row_number() OVER (ORDER BY every_match DESC, text_rank DESC, ${tieBreakOuter}) AS rank
    FROM (
      SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
        s.search @@ ${everyTerm} AS every_match,
        ts_rank_cd(s.search, ${anyTerm}) AS text_rank
      FROM ${scopeOf(sql`matched`)}
        JOIN workspace_knowledge_chunk_search AS s
          ON s.workspace_id = c.workspace_id AND s.unit_id = c.unit_id
          AND s.chunk_hash = c.chunk_hash AND s.occurrence = c.occurrence
      WHERE ${where}
      ORDER BY every_match DESC, text_rank DESC, ${tieBreak}
      LIMIT ${CANDIDATES}
    ) AS ranked`
}

/** The nearest chunks of a large scope, read through the HNSW index. */
export function hnswCandidates(vector: SQL, where: SQL): SQL {
  // `relaxed_order` can return rows a little out of order. The outer
  // `row_number()` sorts them again by distance and then by the key.
  // Only a bare `ORDER BY distance` lets the planner use the HNSW
  // index, so the key breaks ties in the rank window, not here. The
  // distance is the index's expression: the embedding in half precision.
  const half = sql.raw(HALF_EMBEDDING)
  return sql`SELECT ${tieBreakOuter},
      row_number() OVER (ORDER BY distance, ${tieBreakOuter}) AS rank
    FROM (
      SELECT c.workspace_id, c.unit_id, c.chunk_hash, c.occurrence,
        c.embedding::${half} <=> ${vector}::${half} AS distance
      FROM ${scope}
      WHERE ${where} AND c.embedding IS NOT NULL
      ORDER BY distance
      LIMIT ${CANDIDATES}
    ) AS nearest`
}

function textArray(values: readonly string[]): SQL {
  return sql`${sql.param(values)}::text[]`
}
