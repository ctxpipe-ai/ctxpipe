import { sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"

export type Bm25SearchResult = {
  objectId: string
  type: string
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
          rs.object_id,
          ro.type,
          ro.payload,
          ts_rank(to_tsvector('english', rs.content), plainto_tsquery('english', ${query})) AS rank
        FROM retrieval_search rs
        JOIN retrieval_objects ro ON ro.id = rs.object_id AND ro.org_id = ${orgId}
        WHERE ro.org_id = ${orgId}
          AND to_tsvector('english', rs.content) @@ plainto_tsquery('english', ${query})
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
        type: string
        payload: Record<string, unknown>
        rank: number
      }[]
    ).map((r) => ({
      objectId: r.object_id,
      type: r.type,
      payload: r.payload,
      rank: Number(r.rank),
    }))
  })
}
