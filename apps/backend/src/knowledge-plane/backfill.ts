import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { readyKnowledgeHeads } from "../models/knowledge-state.js"
import { listOrgWorkspaces } from "../models/workspaces.js"
import { log } from "../observability/logger.js"
import { enqueueWorkflow } from "../openworkflow/client.js"
import { knowledgeProjection } from "../openworkflow/workflows/knowledge-projection.js"

/**
 * The backfill of the knowledge plane of one org (CTX-1643): queue one
 * `knowledge-projection` run of the default branch for each Workspace that
 * has a tip but no ready head at that tip. A ready head at an earlier tip is
 * stale: for example, the Workspace of an org that had the flag `off`
 * after it was `on` got no run for its later commits. A Workspace with no
 * tip gets its run from its first hydrate.
 *
 * Each deploy calls it, not only the first: thus the next deploy queues
 * again a Workspace whose first run failed. The runs have no
 * idempotency key for the same reason. A second queued run of a Workspace
 * costs little: it waits for the projection lease, and a run of a tip that
 * is already applied returns `current` (ADR-067 decision 3).
 *
 * The deploy calls it on the owner URL, which RLS does not limit. Thus each
 * query here must filter by `orgId` itself.
 *
 * Logs one `knowledge_plane.backfill` event with the queued Workspace ids,
 * and no name. Returns the ids.
 */
export async function backfillKnowledgePlane(orgId: string): Promise<string[]> {
  const workspaceIds = await withOrgDbContext(orgId, async () => {
    const withTip = (await listOrgWorkspaces(orgId)).filter(
      (workspace) => workspace.desiredSha,
    )
    const ready = await readyKnowledgeHeads(
      orgId,
      withTip.map((workspace) => workspace.id),
    )
    return withTip
      .filter(
        (workspace) => ready.get(workspace.id)?.sha !== workspace.desiredSha,
      )
      .map((workspace) => workspace.id)
  })
  for (const workspaceId of workspaceIds)
    await enqueueWorkflow(knowledgeProjection.spec, { orgId, workspaceId })
  log.info({
    step: "knowledge_plane.backfill",
    message:
      "queued the knowledge projection of each Workspace that is not ready at its tip",
    orgId,
    count: workspaceIds.length,
    workspaceIds,
  })
  return workspaceIds
}

/**
 * The backfill of each org, for the deploy of a new version (CTX-1712: the
 * plane serves every org, with no operator step). An org whose backfill fails is logged, and the other
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
        step: "knowledge_plane.backfill_failed",
        message: "the backfill of the org failed",
        orgId,
        error: formatUnknownError(error),
      })
    }
  }
}
