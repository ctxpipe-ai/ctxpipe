import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../../../db/client.js"
import { retrievalObjects } from "../../../db/schema/retrieval_objects.js"
import { generateEmbedding } from "../../../retrieval/services/embedding.js"
import {
  upsertRetrievalEmbedding,
  upsertRetrievalSearch,
} from "../../../retrieval/services/retrievalObjectWrite.js"

export type EmbedState = {
  repositoryId: string
  orgId: string
  targetHash: string
  indexedAt?: string
  objectIds?: string[]
  claimIds?: string[]
}

/**
 * Generates embeddings for retrieval objects and writes to retrieval_embeddings
 * and retrieval_search. Uses objectIds from extract; if empty, skips.
 */
export async function embed(state: EmbedState): Promise<void> {
  const { orgId, objectIds = [] } = state
  if (objectIds.length === 0) return

  const objects = await withOrgDbContext(orgId, async (db) =>
    db
      .select({ id: retrievalObjects.id, payload: retrievalObjects.payload })
      .from(retrievalObjects)
      .where(
        and(
          eq(retrievalObjects.orgId, orgId),
          inArray(retrievalObjects.id, objectIds),
        ),
      ),
  )

  for (const obj of objects) {
    const payload = obj.payload as { content?: string; path?: string }
    const content = payload.content ?? ""
    const path = payload.path ?? ""
    const searchContent = content.length > 0 ? content : path

    if (searchContent.length === 0) continue

    const embedding = await generateEmbedding(searchContent)
    await upsertRetrievalEmbedding(orgId, obj.id, embedding)
    await upsertRetrievalSearch(orgId, obj.id, searchContent)
  }
}
