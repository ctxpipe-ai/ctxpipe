import { and, eq, inArray } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getOrgDb, withOrgDbContext } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { getLogger } from "../../../observability/logger.js"
import { generateEmbedding } from "../../../retrieval/services/modelProvider.js"
import {
  computeEmbeddingSearchContentForObject,
  upsertRetrievalEmbedding,
  upsertRetrievalSearch,
} from "../../../retrieval/services/retrievalObjectWrite.js"
import type { CodeIngestionState } from "../schemas.js"

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

/**
 * Generates embeddings for user-searchable fields (name, summary) of retrieval objects.
 * Uses `getObjectIdsForEmbedding`; if empty, skips.
 */
export async function embed(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
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

  const rows = await withOrgDbContext(state.orgId, async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    return db
      .select({
        id: objects.id,
        kind: objects.kind,
        payload: objects.payload,
      })
      .from(objects)
      .where(and(eq(objects.orgId, orgId), inArray(objects.id, objectIds)))
  })

  let objectsEmbedded = 0
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

    const embedding = await generateEmbedding(searchContent)
    await withOrgDbContext(state.orgId, async () => {
      const orgId = requireCurrentOrgId()
      await upsertRetrievalEmbedding(orgId, obj.id, embedding)
      await upsertRetrievalSearch(orgId, obj.id, searchContent)
    })
    objectsEmbedded++
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
