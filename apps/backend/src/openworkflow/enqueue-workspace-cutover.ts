import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceCutover } from "./workflows/workspace-cutover.js"

export async function enqueueWorkspaceCutover(
  orgId: string,
  log: { error: (err: Error) => void },
): Promise<void> {
  try {
    await runWorkflowWithWorkerWake(workspaceCutover.spec, { orgId })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
