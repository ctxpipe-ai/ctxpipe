import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { readyKnowledgeHeads } from "../models/knowledge-state.js"
import { getOrgFeature } from "../models/org-features.js"
import { listOrgWorkspaces } from "../models/workspaces.js"
import { log } from "../observability/logger.js"
import { enqueueWorkflow } from "../openworkflow/client.js"
import { knowledgeProjection } from "../openworkflow/workflows/knowledge-projection.js"

/**
 * The backfill of the knowledge plane of one org (CTX-1643): when its
 * `knowledge_plane` flag is not `off`, queue one `knowledge-projection` run
 * of the default branch for each Workspace that has a tip but no ready head.
 * A Workspace with no tip gets its run from its first hydrate.
 *
 * Call it on each run of the operator path, not only on a change: thus the
 * next run queues again a Workspace whose first run failed. The runs have no
 * idempotency key for the same reason. A second queued run of a Workspace
 * costs little: it waits for the projection lease, and a run of a tip that
 * is already applied returns `current` (ADR-067 decision 3).
 *
 * Logs one `knowledge_plane.backfill` event with the queued Workspace ids,
 * and no name. Returns the ids.
 */
export async function backfillKnowledgePlane(orgId: string): Promise<string[]> {
  if ((await getOrgFeature(orgId, "knowledge_plane")) === "off") return []
  const workspaceIds = await withOrgDbContext(orgId, async () => {
    const withTip = (await listOrgWorkspaces(orgId))
      .filter((workspace) => workspace.desiredSha)
      .map((workspace) => workspace.id)
    const ready = await readyKnowledgeHeads(orgId, withTip)
    return withTip.filter((id) => !ready.has(id))
  })
  for (const workspaceId of workspaceIds)
    await enqueueWorkflow(knowledgeProjection.spec, { orgId, workspaceId })
  log.info({
    step: "knowledge_plane.backfill",
    message: "queued the first knowledge projection of each Workspace that is not ready",
    orgId,
    count: workspaceIds.length,
    workspaceIds,
  })
  return workspaceIds
}

/**
 * The backfill of each org, for the deploy of a new version (a self-host has
 * no operator step). An org whose backfill fails is logged, and the other
 * orgs go on.
 */
export async function backfillAllKnowledgePlanes(): Promise<void> {
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.id)
  for (const { id: orgId } of orgs) {
    try {
      await backfillKnowledgePlane(orgId)
    } catch (error) {
      log.error({
        step: "knowledge_plane.backfill",
        message: "the backfill of the org failed",
        orgId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
