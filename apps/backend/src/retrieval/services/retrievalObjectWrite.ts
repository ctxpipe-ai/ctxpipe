import { and, eq } from "drizzle-orm"
import { getOrgDb } from "../../db/client.js"
import {
  retrievalEmbeddings,
  retrievalObjects,
  retrievalSearch,
} from "../../db/schema/index.js"
import { generateObjectId } from "../../lib/id.js"

export type UpsertRetrievalObjectByDeduplicationKeyInput = {
  type: string
  deduplicationKey: string
  payload: Record<string, unknown>
}

/**
 * Upserts a retrieval object by deduplicationKey. Uses getOrgDb() - must be called within org context.
 */
export async function upsertRetrievalObjectByDeduplicationKey(
  orgId: string,
  input: UpsertRetrievalObjectByDeduplicationKeyInput,
): Promise<string> {
  const db = getOrgDb()
  const now = new Date()

  const existing = await db
    .select({ id: retrievalObjects.id })
    .from(retrievalObjects)
    .where(
      and(
        eq(retrievalObjects.orgId, orgId),
        eq(retrievalObjects.deduplicationKey, input.deduplicationKey),
      ),
    )
    .limit(1)

  if (existing[0]) {
    await db
      .update(retrievalObjects)
      .set({ payload: input.payload, updatedAt: now })
      .where(eq(retrievalObjects.id, existing[0].id))
    return existing[0].id
  }

  const id = generateObjectId("obj")
  await db.insert(retrievalObjects).values({
    id,
    orgId,
    type: input.type,
    deduplicationKey: input.deduplicationKey,
    payload: input.payload,
  })
  return id
}

/**
 * Upserts retrieval_embedding for an object. Replaces existing embedding.
 * Uses getOrgDb() - must be called within org context.
 */
export async function upsertRetrievalEmbedding(
  orgId: string,
  objectId: string,
  embedding: number[],
): Promise<string> {
  const db = getOrgDb()
  const id = generateObjectId("emb")

  await db
    .delete(retrievalEmbeddings)
    .where(eq(retrievalEmbeddings.objectId, objectId))

  await db.insert(retrievalEmbeddings).values({
    id,
    orgId,
    objectId,
    embedding,
  })

  return id
}

/**
 * Upserts retrieval_search content for BM25. Replaces existing content.
 * Uses getOrgDb() - must be called within org context.
 */
export async function upsertRetrievalSearch(
  _orgId: string,
  objectId: string,
  content: string,
): Promise<void> {
  const db = getOrgDb()

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
}
