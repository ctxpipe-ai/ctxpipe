import { persistHydrateFailure } from "../models/workspaces.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
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
  try {
    await runWorkflowWithWorkerWake(workspaceHydrate.spec, input)
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      await withOrgDbContext(input.orgId, () =>
        persistHydrateFailure({
          workspaceId: input.workspaceId,
          message: error.message,
        }),
      )
    } catch {
      // Persist is best-effort when org db is not open.
    }
  }
}
