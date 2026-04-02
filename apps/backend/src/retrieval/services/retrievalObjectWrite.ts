import { and, eq } from "drizzle-orm"
import { getOrgDb } from "../../db/client.js"
import { objects } from "../../db/schema/index.js"
import { generateObjectId } from "../../lib/id.js"

export type UpsertRetrievalObjectByDeduplicationKeyInput = {
  kind: string
  deduplicationKey: string
  payload: Record<string, unknown>
}

/**
 * Shallow merge for incremental extraction: consumer-inferred stubs must not clobber
 * richer payloads; full extractions must replace prior stubs.
 */
export function mergeRetrievalObjectPayloads(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (incoming.inferredFromConsumer === true) {
    return { ...incoming, ...existing }
  }
  if (existing.inferredFromConsumer === true) {
    return { ...existing, ...incoming }
  }
  return { ...existing, ...incoming }
}

/**
 * Upserts a retrieval object by deduplicationKey. Uses getOrgDb() - must be called within org context.
 * On update, merges payloads so partial runs (e.g. API client stubs) do not wipe prior detail.
 */
export async function upsertRetrievalObjectByDeduplicationKey(
  orgId: string,
  input: UpsertRetrievalObjectByDeduplicationKeyInput,
): Promise<string> {
  const db = getOrgDb()
  const now = new Date()

  const existing = await db
    .select({ id: objects.id, payload: objects.payload })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.deduplicationKey, input.deduplicationKey),
      ),
    )
    .limit(1)

  if (existing[0]) {
    const prev =
      typeof existing[0].payload === "object" && existing[0].payload !== null
        ? (existing[0].payload as Record<string, unknown>)
        : {}
    const merged = mergeRetrievalObjectPayloads(prev, input.payload)
    await db
      .update(objects)
      .set({ payload: merged, updatedAt: now })
      .where(eq(objects.id, existing[0].id))
    return existing[0].id
  }

  const id = generateObjectId("obj")
  await db.insert(objects).values({
    id,
    orgId,
    kind: input.kind,
    deduplicationKey: input.deduplicationKey,
    payload: input.payload,
  })
  return id
}

/**
 * Upserts embedding for an object row. Replaces existing embedding.
 * Uses getOrgDb() - must be called within org context.
 */
export async function upsertRetrievalEmbedding(
  orgId: string,
  objectId: string,
  embedding: number[],
): Promise<void> {
  const db = getOrgDb()
  const now = new Date()
  await db
    .update(objects)
    .set({ embedding, updatedAt: now })
    .where(and(eq(objects.id, objectId), eq(objects.orgId, orgId)))
}

/**
 * Upserts BM25 search text on the object row. Replaces existing content.
 * Uses getOrgDb() - must be called within org context.
 */
export async function upsertRetrievalSearch(
  _orgId: string,
  objectId: string,
  content: string,
): Promise<void> {
  const db = getOrgDb()
  const now = new Date()
  await db
    .update(objects)
    .set({ searchContent: content, updatedAt: now })
    .where(eq(objects.id, objectId))
}
