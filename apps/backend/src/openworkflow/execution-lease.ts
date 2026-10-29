import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * One OpenWorkflow execution of a workflow run (CTX-1080). When the worker
 * does not extend the lease of a run in 30 s (for example, its event loop
 * stalls), another worker claims the run again, and a second execution
 * starts. The first execution does not stop: OpenWorkflow refuses only its
 * next write to the run. Long step bodies use `ownsRun` to stop before costly
 * work.
 */
export type WorkflowExecution = {
  workflowRunId: string
  /** The OpenWorkflow worker id of the execution (one for each worker slot). */
  workerId: string
  /**
   * The execution attempt of the run (its `attempts` at the claim of this
   * execution). `ownsRun` sets it when it finds the lease.
   */
  attempt?: number
  /**
   * True while this execution owns the run: the run is `running` and its
   * `worker_id` is the worker id of this execution. This is the condition
   * that OpenWorkflow uses for each write of the run.
   */
  ownsRun(): Promise<boolean>
}

/**
 * The execution of the workflow body that got `step`. OpenWorkflow 0.10 gives
 * the worker id of the execution only on its step executor. When the field is
 * not there (another OpenWorkflow version), the result is undefined and no
 * step checks the lease.
 */
export function openWorkflowExecution(
  step: object,
  workflowRunId: string,
): WorkflowExecution | undefined {
  const workerId = (step as { workerId?: unknown }).workerId
  if (typeof workerId !== "string") return undefined
  const execution: WorkflowExecution = {
    workflowRunId,
    workerId,
    async ownsRun() {
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
      const row = result.rows[0]
      if (row?.status !== "running" || row.worker_id !== workerId) return false
      // Only the claim of this execution set its worker id on the run, so
      // the `attempts` of the row is the attempt of this execution.
      execution.attempt = Number(row.attempts)
      return true
    },
  }
  return execution
}

/** Another execution owns the workflow run; this execution must stop. */
export class WorkflowLeaseLostError extends Error {
  constructor(readonly execution: WorkflowExecution) {
    super(
      `Another execution owns the workflow run ${execution.workflowRunId}; this execution stops`,
    )
    this.name = "WorkflowLeaseLostError"
  }
}
