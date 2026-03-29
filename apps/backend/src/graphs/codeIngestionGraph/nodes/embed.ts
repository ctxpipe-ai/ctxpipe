import { and, eq, inArray } from "drizzle-orm"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getOrgDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { generateEmbedding } from "../../../retrieval/services/modelProvider.js"
import {
  upsertRetrievalEmbedding,
  upsertRetrievalSearch,
} from "../../../retrieval/services/retrievalObjectWrite.js"
import type { CodeIngestionState } from "../schemas.js"

/**
 * Object ids to embed. In `full` mode, uses `objectIds` (all upserts from extraction).
 * In `partial` mode, uses `touchedObjectIds` from `deduplicateAndStore` (same upsert set as
 * `objectIds` today); falls back to `objectIds` if `touchedObjectIds` is missing (older checkpoints).
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
  if (objectIds.length === 0) return {}

  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const rows = await db
    .select({
      id: objects.id,
      kind: objects.kind,
      payload: objects.payload,
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, objectIds)))

  for (const obj of rows) {
    const payload = obj.payload as {
      name?: string
      summary?: string
      intent?: string
      source_excerpt?: string
    }
    let searchContent: string
    if (obj.kind === "InstructionUnit") {
      const excerpt =
        typeof payload.source_excerpt === "string"
          ? payload.source_excerpt.slice(0, 6_000)
          : ""
      const parts = [
        payload.name,
        payload.summary,
        typeof payload.intent === "string" ? payload.intent : "",
        excerpt,
      ].filter((s): s is string => typeof s === "string" && s.length > 0)
      searchContent = parts.join("\n\n").trim()
    } else {
      const parts = [payload.name, payload.summary].filter(Boolean) as string[]
      searchContent = parts.join(" ").trim()
    }

    if (searchContent.length === 0) continue

    const embedding = await generateEmbedding(searchContent)
    await upsertRetrievalEmbedding(orgId, obj.id, embedding)
    await upsertRetrievalSearch(orgId, obj.id, searchContent)
  }

  return {}
}
