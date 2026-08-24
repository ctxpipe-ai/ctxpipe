import { assertNotInOrgDbContext } from "../db/client.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceTipCheck } from "./workflows/workspace-tip-check.js"

export async function enqueueWorkspaceTipCheck(
  orgId: string,
  log: { error: (err: Error) => void },
): Promise<void> {
  assertNotInOrgDbContext()
  try {
    await runWorkflowWithWorkerWake(workspaceTipCheck.spec, { orgId })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
