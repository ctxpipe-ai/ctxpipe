import { sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"

export type Bm25SearchResult = {
  objectId: string
  kind: string
  payload: Record<string, unknown>
  rank: number
}

/**
 * Full-text BM25 search using PostgreSQL ts_rank and to_tsvector.
 * Returns retrieval objects ordered by descending rank.
 */
export async function bm25Search(
  orgId: string,
  query: string,
  options?: { limit?: number },
): Promise<Bm25SearchResult[]> {
  const limit = options?.limit ?? 20

  return withOrgDbContext(orgId, async (db) => {
    const result = await db.execute(
      sql`
        SELECT
          o.id AS object_id,
          o.kind,
          o.payload,
          ts_rank(to_tsvector('english', o.search_content), plainto_tsquery('english', ${query})) AS rank
        FROM objects o
        WHERE o.org_id = ${orgId}
          AND o.search_content IS NOT NULL
          AND to_tsvector('english', o.search_content) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `,
    )

    const rows =
      (result as { rows?: unknown[] }).rows ??
      (Array.isArray(result) ? result : [])
    return (
      rows as {
        object_id: string
        kind: string
        payload: Record<string, unknown>
        rank: number
      }[]
    ).map((r) => ({
      objectId: r.object_id,
      kind: r.kind,
      payload: r.payload,
      rank: Number(r.rank),
    }))
  })
}
