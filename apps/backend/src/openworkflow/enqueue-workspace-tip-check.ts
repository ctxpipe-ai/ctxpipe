import { assertNotInOrgDbContext } from "../db/client.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceTipCheck } from "./workflows/workspace-tip-check.js"

/**
 * Resolves true when a run is queued or running that will write a result.
 * `hour` is the UTC hour (`YYYY-MM-DDTHH`) of the retry keys of the check;
 * `availableAt` is the time that the run starts.
 */
export async function enqueueWorkspaceTipCheck(
  orgId: string,
  log: { error: (err: Error) => void },
  options?: { idempotencyKey?: string; hour?: string; availableAt?: Date },
): Promise<boolean> {
  assertNotInOrgDbContext()
  const { hour, ...runOptions } = options ?? {}
  try {
    const handle = await runWorkflowWithWorkerWake(
      workspaceTipCheck.spec,
      { orgId, ...(hour ? { hour } : {}) },
      runOptions,
    )
    // A repeated idempotency key returns the earlier run. That run still
    // writes a result only while it is pending or running.
    return ["pending", "running"].includes(handle.workflowRun.status)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
    return false
  }
}
