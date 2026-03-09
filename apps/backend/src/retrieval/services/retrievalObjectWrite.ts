import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import {
  retrievalEmbeddings,
  retrievalObjects,
  retrievalSearch,
} from "../../db/schema/index.js"
import { generateObjectId } from "../../lib/id.js"

export type UpsertRetrievalObjectInput = {
  id?: string
  type: string
  payload: Record<string, unknown>
}

/**
 * Upserts a retrieval object. If id is provided and exists, updates payload.
 * Otherwise creates a new object.
 */
export async function upsertRetrievalObject(
  orgId: string,
  input: UpsertRetrievalObjectInput,
): Promise<string> {
  const id = input.id ?? generateObjectId("obj")
  const now = new Date()

  await withOrgDbContext(orgId, async (db) => {
    const existing = await db
      .select({ id: retrievalObjects.id })
      .from(retrievalObjects)
      .where(eq(retrievalObjects.id, id))
      .limit(1)

    if (existing.length > 0) {
      await db
        .update(retrievalObjects)
        .set({ payload: input.payload, updatedAt: now })
        .where(eq(retrievalObjects.id, id))
    } else {
      await db.insert(retrievalObjects).values({
        id,
        orgId,
        type: input.type,
        payload: input.payload,
      })
    }
  })

  return id
}

/**
 * Upserts retrieval_embedding for an object. Replaces existing embedding.
 */
export async function upsertRetrievalEmbedding(
  orgId: string,
  objectId: string,
  embedding: number[],
): Promise<string> {
  const id = generateObjectId("emb")

  await withOrgDbContext(orgId, async (db) => {
    await db
      .delete(retrievalEmbeddings)
      .where(eq(retrievalEmbeddings.objectId, objectId))

    await db.insert(retrievalEmbeddings).values({
      id,
      orgId,
      objectId,
      embedding,
    })
  })

  return id
}

/**
 * Upserts retrieval_search content for BM25. Replaces existing content.
 */
export async function upsertRetrievalSearch(
  orgId: string,
  objectId: string,
  content: string,
): Promise<void> {
  await withOrgDbContext(orgId, async (db) => {
    const existing = await db
      .select({ objectId: retrievalSearch.objectId })
      .from(retrievalSearch)
      .where(eq(retrievalSearch.objectId, objectId))
      .limit(1)

    if (existing.length > 0) {
      await db
        .update(retrievalSearch)
        .set({ content })
        .where(eq(retrievalSearch.objectId, objectId))
    } else {
      await db.insert(retrievalSearch).values({
        objectId,
        content,
      })
    }
  })
}
