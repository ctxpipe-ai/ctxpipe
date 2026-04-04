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
 * Text used for embeddings / BM25 in the code ingestion embed node.
 * Kept in sync with that node so upsert can skip re-embedding when only non-search fields change.
 */
export function computeEmbeddingSearchContentForObject(
  kind: string,
  payload: Record<string, unknown>,
): string {
  const p = payload as {
    name?: string
    summary?: string
    intent?: string
    source_excerpt?: string
  }
  if (kind === "InstructionUnit") {
    const excerpt =
      typeof p.source_excerpt === "string"
        ? p.source_excerpt.slice(0, 6_000)
        : ""
    const parts = [
      p.name,
      p.summary,
      typeof p.intent === "string" ? p.intent : "",
      excerpt,
    ].filter((s): s is string => typeof s === "string" && s.length > 0)
    return parts.join("\n\n").trim()
  }
  const parts = [p.name, p.summary].filter(Boolean) as string[]
  return parts.join(" ").trim()
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

export type UpsertRetrievalObjectResult = {
  id: string
  /** False when an existing row was updated but embedding search text is unchanged. */
  needsEmbeddingRefresh: boolean
}

/**
 * Upserts a retrieval object by deduplicationKey. Uses getOrgDb() - must be called within org context.
 * On update, merges payloads so partial runs (e.g. API client stubs) do not wipe prior detail.
 */
export async function upsertRetrievalObjectByDeduplicationKey(
  orgId: string,
  input: UpsertRetrievalObjectByDeduplicationKeyInput,
): Promise<UpsertRetrievalObjectResult> {
  const db = getOrgDb()
  const now = new Date()

  const existing = await db
    .select({ id: objects.id, payload: objects.payload, kind: objects.kind })
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
    const kind = existing[0].kind
    const beforeText = computeEmbeddingSearchContentForObject(kind, prev)
    const afterText = computeEmbeddingSearchContentForObject(kind, merged)
    const needsEmbeddingRefresh = beforeText !== afterText

    await db
      .update(objects)
      .set({ payload: merged, updatedAt: now })
      .where(eq(objects.id, existing[0].id))
    return { id: existing[0].id, needsEmbeddingRefresh }
  }

  const id = generateObjectId("obj")
  await db.insert(objects).values({
    id,
    orgId,
    kind: input.kind,
    deduplicationKey: input.deduplicationKey,
    payload: input.payload,
  })
  return { id, needsEmbeddingRefresh: true }
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
