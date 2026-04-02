import { sql } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"

export type VectorSearchResult = {
  objectId: string
  kind: string
  payload: Record<string, unknown>
  distance: number
}

/**
 * Vector similarity search using pgvector cosine distance.
 * Returns retrieval objects ordered by ascending distance (nearest first).
 */
export async function vectorSearch(
  orgId: string,
  embedding: number[],
  options?: { limit?: number },
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 20
  const embeddingStr = `[${embedding.join(",")}]`

  return withOrgDbContext(orgId, async (db) => {
    const result = await db.execute(
      sql`
        SELECT
          o.id AS object_id,
          o.kind,
          o.payload,
          (o.embedding <=> ${embeddingStr}::vector) AS distance
        FROM objects o
        WHERE o.org_id = ${orgId}
          AND o.embedding IS NOT NULL
        ORDER BY o.embedding <=> ${embeddingStr}::vector
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
        distance: number
      }[]
    ).map((r) => ({
      objectId: r.object_id,
      kind: r.kind,
      payload: r.payload,
      distance: Number(r.distance),
    }))
  })
}
