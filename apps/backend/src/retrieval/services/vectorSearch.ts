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
          re.object_id,
          ro.kind,
          ro.payload,
          (re.embedding <=> ${embeddingStr}::vector) AS distance
        FROM retrieval_embeddings re
        JOIN retrieval_objects ro ON ro.id = re.object_id AND ro.org_id = ${orgId}
        WHERE re.org_id = ${orgId}
        ORDER BY re.embedding <=> ${embeddingStr}::vector
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
