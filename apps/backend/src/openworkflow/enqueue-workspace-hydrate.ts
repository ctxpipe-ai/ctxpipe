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
    defaultBranch?: string
  },
  log: { error: (err: Error) => void },
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
    await runWorkflowWithWorkerWake(workspaceHydrate.spec, {
      orgId: input.orgId,
      workspaceId: revision.workspaceId,
      revision,
    })
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
