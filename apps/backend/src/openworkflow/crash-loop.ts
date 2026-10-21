import { sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * The number of worker stops in one step after which the step fails. Three
 * stops in the same step are not deploys: a step takes at most 10 minutes.
 */
export const MAX_CRASHED_STEP_ATTEMPTS = 3

/**
 * The step stopped the worker again and again. The message gives the cause
 * and the fix; it holds no source text.
 */
export class StepCrashLoopError extends Error {
  constructor(
    readonly stepName: string,
    readonly crashes: number,
  ) {
    super(
      `The worker stopped ${crashes} times during the step "${stepName}" (for example, it ran out of memory), so the step failed. Start the run again. If it stops at the same step again, report it to support with this message.`,
    )
    this.name = "StepCrashLoopError"
  }
}

/**
 * The earlier attempts of `stepName` in the workflow run that a worker stop
 * ended. OpenWorkflow writes a function step attempt as `running` before the
 * step body runs. When the worker process stops (out of memory, a crash),
 * no failure is written, and the attempt stays `running`; the next worker
 * makes a new attempt. Call this inside the step body: the attempt of the
 * caller is also `running`, so it does not count.
 */
async function crashedStepAttempts(
  workflowRunId: string,
  stepName: string,
): Promise<number> {
  const result = await getSystemDb().execute<{ running: number }>(sql`
    select count(*)::int as running
    from openworkflow.step_attempts
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_run_id = ${workflowRunId}
      and step_name = ${stepName}
      and kind = 'function'
      and status = 'running'
  `)
  return Math.max(0, (result.rows[0]?.running ?? 0) - 1)
}

/**
 * Run `fn` unless earlier attempts of the step stopped the worker
 * `MAX_CRASHED_STEP_ATTEMPTS` times; then throw `StepCrashLoopError`, so the
 * step fails and the worker does not restart on it again and again
 * (CTX-971).
 */
export async function withCrashLoopGuard<T>(
  workflowRunId: string,
  stepName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const crashes = await crashedStepAttempts(workflowRunId, stepName)
  if (crashes >= MAX_CRASHED_STEP_ATTEMPTS) {
    const error = new StepCrashLoopError(stepName, crashes)
    log.error({
      step: "openworkflow.step-crash-loop",
      message: error.message,
      workflowRunId,
      stepName,
      crashes,
    })
    throw error
  }
  return fn()
}
