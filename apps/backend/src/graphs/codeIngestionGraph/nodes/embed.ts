import { and, eq, inArray } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getOrgDb } from "../../../db/client.js"
import { retrievalObjects } from "../../../db/schema/retrieval_objects.js"
import { generateEmbedding } from "../../../retrieval/services/modelProvider.js"
import {
  upsertRetrievalEmbedding,
  upsertRetrievalSearch,
} from "../../../retrieval/services/retrievalObjectWrite.js"
import type { CodeIngestionState } from "../schemas.js"

/**
 * Generates embeddings for user-searchable fields (name, summary) of retrieval objects.
 * Uses objectIds from state; if empty, skips.
 */
export async function embed(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { objectIds = [] } = state
  if (objectIds.length === 0) return {}

  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const objects = await db
    .select({ id: retrievalObjects.id, payload: retrievalObjects.payload })
    .from(retrievalObjects)
    .where(
      and(
        eq(retrievalObjects.orgId, orgId),
        inArray(retrievalObjects.id, objectIds),
      ),
    )

  for (const obj of objects) {
    const payload = obj.payload as { name?: string; summary?: string }
    const parts = [payload.name, payload.summary].filter(Boolean) as string[]
    const searchContent = parts.join(" ").trim()

    if (searchContent.length === 0) continue

    const embedding = await generateEmbedding(searchContent)
    await upsertRetrievalEmbedding(orgId, obj.id, embedding)
    await upsertRetrievalSearch(orgId, obj.id, searchContent)
  }

  return {}
}
