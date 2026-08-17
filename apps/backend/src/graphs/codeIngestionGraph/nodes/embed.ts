import { and, eq, inArray } from "drizzle-orm"
import { getSystemDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import {
  flushWorkflowLog,
  getLogger,
} from "../../../observability/logger.js"
import {
  EMBEDDING_BATCH_SIZE,
  generateEmbeddings,
} from "../../../retrieval/services/modelProvider.js"
import { computeEmbeddingSearchContentForObject } from "../../../retrieval/services/retrievalObjectWrite.js"
import type { CodeIngestionState } from "../schemas.js"
import { setIngestionIndexingStep } from "../setIngestionIndexingStep.js"

/** Concurrent PG updates after a batch of embeddings is ready. */
const EMBED_UPDATE_CONCURRENCY = 50

/**
 * Object ids to embed. In `full` mode, uses `objectIds` (all upserts from extraction).
 * In `partial` mode, uses `touchedObjectIds` (objects whose embedding-relevant payload changed
 * or were inserted); falls back to `objectIds` if `touchedObjectIds` is missing (older checkpoints).
 */
export function getObjectIdsForEmbedding(state: CodeIngestionState): string[] {
  const objectIds = state.objectIds ?? []
  if (state.ingestMode !== "partial") return objectIds
  return state.touchedObjectIds ?? objectIds
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
 * Generates embeddings for user-searchable fields (name, summary) of retrieval objects.
 * Uses `getObjectIdsForEmbedding`; if empty, skips.
 */
export async function embed(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  await setIngestionIndexingStep(state, "embedding")
  const objectIds = getObjectIdsForEmbedding(state)
  const logger = getLogger()
  if (objectIds.length === 0) {
    logger.set({
      step: "codeIngestion.embed.summary",
      repositoryId: state.repositoryId,
      orgId: state.orgId,
      roots: state.roots,
      objectIdsRequested: 0,
      objectRowsLoaded: 0,
      objectsEmbedded: 0,
      objectsSkippedEmptySearchContent: 0,
    })
    logger.info("embed skipped (no object ids)")
    return {}
  }

  const orgId = state.orgId
  const db = getSystemDb()
  const startedAt = Date.now()

  const rows = await db
    .select({
      id: objects.id,
      kind: objects.kind,
      payload: objects.payload,
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, objectIds)))

  const toEmbed: Array<{ id: string; searchContent: string }> = []
  let objectsSkippedEmptySearchContent = 0

  for (const obj of rows) {
    const payload = obj.payload as Record<string, unknown>
    const searchContent = computeEmbeddingSearchContentForObject(
      obj.kind,
      payload,
    )
    if (searchContent.length === 0) {
      objectsSkippedEmptySearchContent++
      continue
    }
    toEmbed.push({ id: obj.id, searchContent })
  }

  let objectsEmbedded = 0
  const chunks = chunkArray(toEmbed, EMBEDDING_BATCH_SIZE)

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const embeddings = await generateEmbeddings(
      chunk.map((c) => c.searchContent),
    )
    const now = new Date()
    for (const updateChunk of chunkArray(
      chunk.map((c, i) => ({
        id: c.id,
        embedding: embeddings[i] as number[],
        searchContent: c.searchContent,
      })),
      EMBED_UPDATE_CONCURRENCY,
    )) {
      await Promise.all(
        updateChunk.map((u) =>
          db
            .update(objects)
            .set({
              embedding: u.embedding,
              searchContent: u.searchContent,
              updatedAt: now,
            })
            .where(and(eq(objects.id, u.id), eq(objects.orgId, orgId))),
        ),
      )
    }
    objectsEmbedded += chunk.length

    logger.set({
      step: "codeIngestion.embed.progress",
      repositoryId: state.repositoryId,
      orgId: state.orgId,
      roots: state.roots,
      objectsEmbedded,
      objectsToEmbed: toEmbed.length,
      chunkIndex: chunkIndex + 1,
      chunkCount: chunks.length,
      elapsedMs: Date.now() - startedAt,
    })
    logger.info("embed progress")
    flushWorkflowLog()
  }

  logger.set({
    step: "codeIngestion.embed.summary",
    repositoryId: state.repositoryId,
    orgId: state.orgId,
    roots: state.roots,
    objectIdsRequested: objectIds.length,
    objectRowsLoaded: rows.length,
    objectsEmbedded,
    objectsSkippedEmptySearchContent,
  })
  logger.info("embed summary")

  return {}
}
