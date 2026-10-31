import { parseEnv } from "../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { persistHydrateFailure } from "../models/workspaces.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceHydrate } from "./workflows/workspace-hydrate.js"

export async function enqueueWorkspaceHydrate(
  input: {
    orgId: string
    workspaceId: string
  },
  log: { error: (err: Error) => void },
  options?: {
    idempotencyKey: (revision: WorkspaceRevision) => string
    /** Project the revision again, also when it is the active one. */
    reproject?: true
  },
): Promise<void> {
  assertNotInOrgDbContext()
  let revision: WorkspaceRevision | undefined
  try {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: parseEnv(process.env),
    })
    if (!resolved) return
    revision = resolved.revision
    await runWorkflowWithWorkerWake(
      workspaceHydrate.spec,
      {
        orgId: input.orgId,
        workspaceId: revision.workspaceId,
        revision,
        ...(options?.reproject ? { reproject: true as const } : {}),
      },
      options && { idempotencyKey: options.idempotencyKey(revision) },
    )
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      if (revision)
        await withOrgDbContext(input.orgId, () =>
          persistHydrateFailure({
            revision: revision as WorkspaceRevision,
            message: error.message,
          }),
        )
    } catch {
      // Persist is best-effort when org db is not open.
    }
  }
}

/**
 * Start one hydrate run that writes the graph of a published revision again
 * from the PostgreSQL projection. The key names the Workspace, the revision
 * and the trigger (the time of a graph loss, or the UTC hour of a manual
 * rebuild), so each trigger starts one run. Returns true when the run waits
 * for a worker, and false when the key gives a run that started before.
 */
export async function enqueueWorkspaceGraphRebuild(input: {
  orgId: string
  revision: WorkspaceRevision
  revisionKey: string
  trigger: string
}): Promise<boolean> {
  const handle = await runWorkflowWithWorkerWake(
    workspaceHydrate.spec,
    {
      orgId: input.orgId,
      workspaceId: input.revision.workspaceId,
      revision: input.revision,
    },
    {
      idempotencyKey: `workspace-graph-rebuild:${input.revision.workspaceId}:${input.revisionKey}:${input.trigger}`,
    },
  )
  return handle.workflowRun.status === "pending"
}
