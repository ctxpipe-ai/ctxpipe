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
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
