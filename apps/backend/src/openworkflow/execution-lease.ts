import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * One OpenWorkflow execution of a workflow run (CTX-1080). A worker must
 * extend the lease of a run in 30 s. When it does not (for example, its
 * event loop stalls), another worker claims the run again, and a second
 * execution starts. The first execution does not stop: OpenWorkflow refuses
 * only its next write to the run. Long step bodies use `ownsRun` to stop
 * before costly work.
 */
export type WorkflowExecution = {
  workflowRunId: string
  /** The OpenWorkflow worker id of the execution (one for each worker slot). */
  workerId: string
  /**
   * The execution attempt of the run while this execution owns the run, else
   * undefined. The execution owns the run when the run is `running` and its
   * `worker_id` is the worker id of this execution. This is the condition
   * that OpenWorkflow uses for each write of the run. The execution attempt
   * is the `attempts` of the run at the claim of this execution. A failed
   * read of the run throws.
   */
  ownsRun(): Promise<number | undefined>
  /**
   * Who has the run now. `owned`: this execution owns it. `taken`: another
   * execution owns it (the run is `running` with another worker id), or
   * another execution parked it (`sleeping`) or set it back to `pending`.
   * `ended`: the run has a terminal status, or it is not there. A failed
   * read of the run throws.
   */
  leaseState(): Promise<LeaseState>
}

type LeaseState = "owned" | "taken" | "ended"

/**
 * The execution of the workflow body that got `step`. OpenWorkflow 0.10 gives
 * the worker id of the execution only on its step executor, and its types do
 * not show it. When the field is not there (another OpenWorkflow version),
 * the result is undefined and no step checks the lease. A warn event then
 * shows that the check is off.
 */
export function openWorkflowExecution(
  step: object,
  workflowRunId: string,
): WorkflowExecution | undefined {
  const workerId = (step as { workerId?: unknown }).workerId
  if (typeof workerId !== "string") {
    log.warn({
      step: "openworkflow.worker_id_missing",
      message:
        "The OpenWorkflow step executor has no worker id; no step checks the lease of its run",
      workflowRunId,
    })
    return undefined
  }
  const readRun = async () => {
    const result = await getSystemDb().execute<{
      status: string
      worker_id: string | null
      attempts: number
    }>(sql`
      select status, worker_id, attempts
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()}
        and id = ${workflowRunId}
    `)
    return result.rows[0]
  }
  return {
    workflowRunId,
    workerId,
    async ownsRun() {
      const row = await readRun()
      if (row?.status !== "running" || row.worker_id !== workerId)
        return undefined
      // Only the claim of this execution set its worker id on the run, so
      // the `attempts` of the row is the attempt of this execution.
      return Number(row.attempts)
    },
    async leaseState() {
      const row = await readRun()
      if (row?.status === "running")
        return row.worker_id === workerId ? "owned" : "taken"
      // While this execution runs, only another execution can park the run
      // or set it back to `pending`. That execution continues the run later.
      if (row?.status === "sleeping" || row?.status === "pending")
        return "taken"
      return "ended"
    },
  }
}

/** Another execution owns the workflow run; this execution must stop. */
export class WorkflowLeaseLostError extends Error {
  constructor(workflowRunId: string) {
    super(
      `Another execution owns the workflow run ${workflowRunId}; this execution stops`,
    )
    this.name = "WorkflowLeaseLostError"
  }
}
