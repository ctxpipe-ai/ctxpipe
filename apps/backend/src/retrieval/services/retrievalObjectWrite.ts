import { and, eq, inArray } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { objects } from "../../db/schema/index.js"
import { generateObjectId } from "../../lib/id.js"

/** Chunk size for IN-list prefetch / batch insert / batch update. */
export const RETRIEVAL_OBJECT_UPSERT_BATCH_SIZE = 500

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
 * Collapse duplicate deduplication keys in encounter order, merging payloads with
 * {@link mergeRetrievalObjectPayloads} (same semantics as successive single upserts).
 */
export function collapseUpsertInputsByDeduplicationKey(
  inputs: UpsertRetrievalObjectByDeduplicationKeyInput[],
): UpsertRetrievalObjectByDeduplicationKeyInput[] {
  const byKey = new Map<string, UpsertRetrievalObjectByDeduplicationKeyInput>()
  for (const input of inputs) {
    const prev = byKey.get(input.deduplicationKey)
    if (!prev) {
      byKey.set(input.deduplicationKey, input)
      continue
    }
    byKey.set(input.deduplicationKey, {
      kind: input.kind,
      deduplicationKey: input.deduplicationKey,
      payload: mergeRetrievalObjectPayloads(prev.payload, input.payload),
    })
  }
  return [...byKey.values()]
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Batch upsert by deduplicationKey: one SELECT per chunk, then batch INSERT and
 * concurrent chunked UPDATEs (same merge / embedding-refresh semantics as the
 * single-key upsert). Each chunk runs in its own `withOrgDbContext` transaction
 * so large ingestions do not hold one pool client for the full upsert.
 */
export async function batchUpsertRetrievalObjectsByDeduplicationKey(
  orgId: string,
  inputs: UpsertRetrievalObjectByDeduplicationKeyInput[],
  options?: {
    batchSize?: number
    onChunk?: (info: {
      processedUniqueKeys: number
      totalUniqueKeys: number
    }) => void
  },
): Promise<Map<string, UpsertRetrievalObjectResult>> {
  const results = new Map<string, UpsertRetrievalObjectResult>()
  if (inputs.length === 0) return results

  const collapsed = collapseUpsertInputsByDeduplicationKey(inputs)
  const batchSize = options?.batchSize ?? RETRIEVAL_OBJECT_UPSERT_BATCH_SIZE
  const now = new Date()
  let processedUniqueKeys = 0

  for (const chunk of chunkArray(collapsed, batchSize)) {
    await withOrgDbContext(orgId, async (db) => {
      const keys = chunk.map((c) => c.deduplicationKey)
      const existingRows = await db
        .select({
          id: objects.id,
          payload: objects.payload,
          kind: objects.kind,
          deduplicationKey: objects.deduplicationKey,
        })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, orgId),
            inArray(objects.deduplicationKey, keys),
          ),
        )

      const existingByKey = new Map<
        string,
        { id: string; payload: Record<string, unknown>; kind: string }
      >()
      for (const row of existingRows) {
        if (!row.deduplicationKey) continue
        const prev =
          typeof row.payload === "object" && row.payload !== null
            ? (row.payload as Record<string, unknown>)
            : {}
        existingByKey.set(row.deduplicationKey, {
          id: row.id,
          payload: prev,
          kind: row.kind,
        })
      }

      const toInsert: Array<{
        id: string
        orgId: string
        kind: string
        deduplicationKey: string
        payload: Record<string, unknown>
      }> = []
      const toUpdate: Array<{ id: string; payload: Record<string, unknown> }> =
        []

      for (const input of chunk) {
        const existing = existingByKey.get(input.deduplicationKey)
        if (existing) {
          const merged = mergeRetrievalObjectPayloads(
            existing.payload,
            input.payload,
          )
          const beforeText = computeEmbeddingSearchContentForObject(
            existing.kind,
            existing.payload,
          )
          const afterText = computeEmbeddingSearchContentForObject(
            existing.kind,
            merged,
          )
          const needsEmbeddingRefresh = beforeText !== afterText
          // Always update like the single-path upsert (even if payload equal).
          toUpdate.push({ id: existing.id, payload: merged })
          results.set(input.deduplicationKey, {
            id: existing.id,
            needsEmbeddingRefresh,
          })
        } else {
          const id = generateObjectId("obj")
          toInsert.push({
            id,
            orgId,
            kind: input.kind,
            deduplicationKey: input.deduplicationKey,
            payload: input.payload,
          })
          results.set(input.deduplicationKey, {
            id,
            needsEmbeddingRefresh: true,
          })
        }
      }

      if (toInsert.length > 0) {
        await db.insert(objects).values(toInsert)
      }

      if (toUpdate.length > 0) {
        await Promise.all(
          toUpdate.map((u) =>
            db
              .update(objects)
              .set({ payload: u.payload, updatedAt: now })
              .where(and(eq(objects.id, u.id), eq(objects.orgId, orgId))),
          ),
        )
      }
    })

    processedUniqueKeys += chunk.length
    options?.onChunk?.({
      processedUniqueKeys,
      totalUniqueKeys: collapsed.length,
    })
  }

  return results
}
