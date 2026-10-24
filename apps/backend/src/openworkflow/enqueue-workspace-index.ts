import { assertNotInOrgDbContext } from "../db/client.js"
import type {
  LinkedRevision,
  WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import { hasPublishedCheckout } from "../models/repositories.js"
import { listWorkspaceIndexTargets } from "../models/workspaces.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceIndex } from "./workflows/workspace-index.js"

export async function enqueueWorkspaceIndex(
  input: {
    orgId: string
    revision: WorkspaceRevision
    linked?: LinkedRevision
  },
  log: { error: (err: Error) => void },
  options?: { idempotencyKey: string },
): Promise<void> {
  assertNotInOrgDbContext()
  try {
    await runWorkflowWithWorkerWake(workspaceIndex.spec, input, options)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * After an ingestion of `repositoryId` publishes `sha`, queue the index of
 * each Workspace that reads the repository: as its own repository or as a
 * linked one. A new Workspace or a new link then becomes readable with no
 * new push. The key names the published SHA, so a replay queues no second
 * job. Call it inside the org context, outside an org database transaction.
 */
export async function enqueueWorkspaceIndexesAfterPublish(
  input: { orgId: string; repositoryId: string; sha: string },
  log: { error: (err: Error) => void },
): Promise<{ queued: number }> {
  assertNotInOrgDbContext()
  // An ingestion that did not publish leaves no checkout. Then the index
  // would start one more ingestion, so it is not queued.
  if (!(await hasPublishedCheckout(input.repositoryId))) return { queued: 0 }
  const targets = await listWorkspaceIndexTargets(input)
  const key = `${input.repositoryId}:${input.sha}`
  for (const revision of targets.owners)
    await enqueueWorkspaceIndex({ orgId: input.orgId, revision }, log, {
      idempotencyKey: `workspace-index-after-publish:${revision.workspaceId}:${revision.generation}:${revision.sha}:${key}`,
    })
  for (const linked of targets.linked)
    await enqueueWorkspaceIndex(
      { orgId: input.orgId, revision: linked.owner, linked },
      log,
      {
        idempotencyKey: `workspace-index-after-publish:${linked.linkId}:${linked.owner.generation}:${linked.owner.sha}:${linked.sha}:${key}`,
      },
    )
  return { queued: targets.owners.length + targets.linked.length }
}
