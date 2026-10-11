import { assertNotInOrgDbContext } from "../db/client.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceTipCheck } from "./workflows/workspace-tip-check.js"

/** Resolves true when a run is queued or running that will write a result. */
export async function enqueueWorkspaceTipCheck(
  orgId: string,
  log: { error: (err: Error) => void },
  options?: { idempotencyKey: string },
): Promise<boolean> {
  assertNotInOrgDbContext()
  try {
    const handle = await runWorkflowWithWorkerWake(
      workspaceTipCheck.spec,
      { orgId },
      options,
    )
    // A repeated idempotency key returns the earlier run. That run still
    // writes a result only while it is pending or running.
    return ["pending", "running"].includes(handle.workflowRun.status)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
    return false
  }
}
