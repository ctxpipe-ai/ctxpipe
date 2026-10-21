import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * The number of worker stops in one step after which the step fails. One
 * worker boot can end at most one attempt of a step: the stop ends that boot.
 * A deploy does not count: the worker marks its attempts `failed` when it
 * gets SIGTERM. A stop that another step caused (one worker runs many steps)
 * can end one attempt, but three in the window are a crash loop.
 */
export const MAX_CRASHED_STEP_ATTEMPTS = 3

/**
 * One id for each worker process boot. The `ingestion-v2.step-attempt-started`
 * events and the crash-loop error carry it, so a log search shows whether the
 * stops of a step came from different worker boots. (OpenWorkflow keeps no
 * worker id on a step attempt.)
 */
export const WORKER_BOOT_ID = randomUUID()

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
 * The attempts of `stepName` in the workflow run that are `running`, the
 * newest first. OpenWorkflow writes a function step attempt as `running`
 * before the step body runs. When the worker process stops (out of memory, a
 * crash), no failure is written, and the attempt stays `running`; the next
 * worker makes a new attempt. Call this inside the step body: the newest
 * attempt is the attempt of the caller, and the others are the attempts that
 * a worker stop ended. `stepName` must be the name that OpenWorkflow stores:
 * a name that is not unique in the run gets a `:1` suffix, so each caller
 * gives a unique name.
 */
async function runningStepAttempts(
  workflowRunId: string,
  stepName: string,
): Promise<string[]> {
  const result = await getSystemDb().execute<{ id: string }>(sql`
    select id
    from openworkflow.step_attempts
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_run_id = ${workflowRunId}
      and step_name = ${stepName}
      and kind = 'function'
      and status = 'running'
      -- Only attempts of the last 2 hours count. A skill step body runs for
      -- about 30 minutes at most (3 attempts of up to 10 minutes each), so
      -- three stops of one step fit, but old deploys do not add up.
      and coalesce(started_at, created_at) >= now() - interval '2 hours'
    order by created_at desc, id desc
  `)
  return result.rows.map((row) => row.id)
}

/**
 * The guarded step attempts that this worker process runs now. The set is
 * on `globalThis` because the OpenWorkflow CLI can load the worker config
 * and the workflow files as different module instances.
 */
const inFlightKey = Symbol.for("ctxpipe.openworkflow.in-flight-step-attempts")
const processGlobals = globalThis as {
  [inFlightKey]?: Set<string>
}
processGlobals[inFlightKey] ??= new Set()
const inFlightAttempts = processGlobals[inFlightKey]

/**
 * Mark the guarded step attempts that this worker process runs now as
 * `failed`. Call it when the worker gets SIGTERM or SIGINT, before the
 * process stops: `Worker.stop()` of OpenWorkflow 0.10 does not end an
 * attempt, so a deploy would leave it `running`, and the crash-loop guard
 * would count the deploy as a crash. The write changes only the attempts of
 * this process. A process that runs out of memory gets no signal, so its
 * attempt stays `running` and the guard counts it. Returns the number of
 * attempts that it marked.
 */
export async function failInFlightStepAttempts(): Promise<number> {
  const ids = [...inFlightAttempts]
  if (ids.length === 0) return 0
  const error = {
    name: "WorkerStoppedError",
    message:
      "The worker stopped during this step (a deploy or a restart). The next worker runs the step again.",
  }
  const result = await getSystemDb().execute<{ id: string }>(sql`
    update openworkflow.step_attempts
    set status = 'failed',
      error = ${JSON.stringify(error)}::jsonb,
      finished_at = now(),
      updated_at = now()
    where namespace_id = ${openWorkflowNamespaceId()}
      and id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      and status = 'running'
    returning id
  `)
  log.warn({
    step: "openworkflow.step-attempts-stopped",
    message: `The worker stopped; marked ${result.rows.length} step attempts failed`,
    stepAttemptIds: result.rows.map((row) => row.id).join(","),
    workerBootId: WORKER_BOOT_ID,
  })
  return result.rows.length
}

/**
 * Run `fn` unless earlier attempts of the step stopped the worker
 * `MAX_CRASHED_STEP_ATTEMPTS` times, so the worker does not restart on the
 * step again and again (CTX-971). Then log the error and return the result of
 * `onCrashLoop` (the step ends with that output and is not retried), or,
 * with no `onCrashLoop`, throw `StepCrashLoopError` (the step fails).
 */
export async function withCrashLoopGuard<T>(
  workflowRunId: string,
  stepName: string,
  fn: () => Promise<T>,
  onCrashLoop?: (error: StepCrashLoopError) => T,
): Promise<T> {
  const [attemptId, ...crashed] = await runningStepAttempts(
    workflowRunId,
    stepName,
  )
  const crashes = crashed.length
  if (crashes >= MAX_CRASHED_STEP_ATTEMPTS) {
    const error = new StepCrashLoopError(stepName, crashes)
    log.error({
      step: "openworkflow.step-crash-loop",
      message: error.message,
      workflowRunId,
      stepName,
      crashes,
      workerBootId: WORKER_BOOT_ID,
    })
    if (onCrashLoop) return onCrashLoop(error)
    throw error
  }
  if (attemptId) inFlightAttempts.add(attemptId)
  try {
    return await fn()
  } finally {
    if (attemptId) inFlightAttempts.delete(attemptId)
  }
}
