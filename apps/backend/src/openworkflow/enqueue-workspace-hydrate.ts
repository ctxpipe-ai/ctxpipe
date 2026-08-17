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
  try {
    await runWorkflowWithWorkerWake(workspaceHydrate.spec, input)
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      await persistHydrateFailure({
        workspaceId: input.workspaceId,
        message: error.message,
      })
    } catch {
      // Persist is best-effort when org db is not open.
    }
  }
}
