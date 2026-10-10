import { and, eq, inArray, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import {
  ingestionPreviewLinks,
  ingestionPreviewNodes,
} from "../db/schema/ingestion_preview.js"
import { repositories } from "../db/schema/repositories.js"
import type {
  ExtractedClaim,
  ExtractedObject,
} from "../graphs/codeIngestionGraph/schemas.js"

/**
 * Adds what an extractor just found to the repository's provisional graph.
 * Safe to repeat (step retries): a row already present only gains a name.
 * Rows go in sorted, in chunks: parallel extractors then lock in the same
 * order, and a large extractor stays under Postgres's bind-parameter cap.
 */
export async function recordIngestionPreview(input: {
  orgId: string
  repositoryId: string
  objects: readonly ExtractedObject[]
  claims: readonly ExtractedClaim[]
}): Promise<void> {
  const nodes = new Map<string, { kind: string; name: string | null }>()
  for (const object of input.objects) {
    nodes.set(object.deduplicationKey, {
      kind: object.kind,
      name: object.name ?? null,
    })
  }
  // Claims can point at entities another extractor or an earlier run owns;
  // keep their endpoints so the links have something to join.
  for (const claim of input.claims) {
    if (!nodes.has(claim.subjectRef)) {
      nodes.set(claim.subjectRef, { kind: claim.subjectKind, name: null })
    }
    if (!nodes.has(claim.objectRef)) {
      nodes.set(claim.objectRef, { kind: claim.objectKind, name: null })
    }
  }
  if (nodes.size === 0) return
  const nodeRows = [...nodes]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([nodeKey, node]) => ({
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      nodeKey,
      kind: node.kind,
      name: node.name,
    }))
  const linkRows = input.claims
    .map((claim) => ({
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      sourceKey: claim.subjectRef,
      targetKey: claim.objectRef,
      predicate: claim.predicate,
    }))
    .sort((a, b) => {
      const ka = `${a.sourceKey}\0${a.targetKey}\0${a.predicate}`
      const kb = `${b.sourceKey}\0${b.targetKey}\0${b.predicate}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  await withOrgDbContext(input.orgId, async (db) => {
    for (const chunk of chunks(nodeRows)) {
      // A claim endpoint can land before the extractor that names it.
      await db
        .insert(ingestionPreviewNodes)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            ingestionPreviewNodes.repositoryId,
            ingestionPreviewNodes.nodeKey,
          ],
          set: {
            name: sql`coalesce(${ingestionPreviewNodes.name}, excluded.name)`,
          },
        })
    }
    for (const chunk of chunks(linkRows)) {
      await db.insert(ingestionPreviewLinks).values(chunk).onConflictDoNothing()
    }
  })
}

function chunks<T>(rows: readonly T[], size = 2000): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/** Drops a repository's provisional graph (run start, and after projection). */
export async function clearIngestionPreview(input: {
  orgId: string
  repositoryId: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, async (db) => {
    await db
      .delete(ingestionPreviewLinks)
      .where(eq(ingestionPreviewLinks.repositoryId, input.repositoryId))
    await db
      .delete(ingestionPreviewNodes)
      .where(eq(ingestionPreviewNodes.repositoryId, input.repositoryId))
  })
}

/**
 * The provisional graph across the org's repositories that are still
 * indexing. A run that failed or finished no longer shows: its rows are
 * either cleared or belong to a repository that is not running.
 */
export async function listIngestionPreview(input: {
  orgId: string
  nodeLimit: number
}): Promise<{
  nodes: Array<{ id: string; kind: string; name: string | null }>
  edges: Array<{ sourceId: string; targetId: string; predicate: string }>
}> {
  return withOrgDbContext(input.orgId, async (db) => {
    const running = db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, input.orgId),
          inArray(repositories.indexingStatus, ["queued", "running"]),
        ),
      )
    const nodeRows = await db
      .selectDistinctOn([ingestionPreviewNodes.nodeKey], {
        id: ingestionPreviewNodes.nodeKey,
        kind: ingestionPreviewNodes.kind,
        name: ingestionPreviewNodes.name,
      })
      .from(ingestionPreviewNodes)
      .where(
        and(
          eq(ingestionPreviewNodes.orgId, input.orgId),
          inArray(ingestionPreviewNodes.repositoryId, running),
        ),
      )
      // The named row wins when repositories share a key.
      .orderBy(
        ingestionPreviewNodes.nodeKey,
        sql`${ingestionPreviewNodes.name} is null`,
      )
      .limit(input.nodeLimit)
    if (nodeRows.length === 0) return { nodes: [], edges: [] }
    const ids = nodeRows.map((node) => node.id)
    const edges = await db
      .selectDistinct({
        sourceId: ingestionPreviewLinks.sourceKey,
        targetId: ingestionPreviewLinks.targetKey,
        predicate: ingestionPreviewLinks.predicate,
      })
      .from(ingestionPreviewLinks)
      .where(
        and(
          eq(ingestionPreviewLinks.orgId, input.orgId),
          inArray(ingestionPreviewLinks.repositoryId, running),
          inArray(ingestionPreviewLinks.sourceKey, ids),
          inArray(ingestionPreviewLinks.targetKey, ids),
        ),
      )
    return { nodes: nodeRows, edges }
  })
}
