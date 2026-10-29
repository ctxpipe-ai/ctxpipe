import type { WorkflowExecution } from "./execution-lease.js"

/**
 * OpenWorkflow parks or finalizes an execution branch by throwing internal
 * control signals. They must reach the worker runtime instead of being handled
 * as application failures.
 */
export function isWorkflowControlSignal(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.name === "SleepSignal" ||
    err.name === "SleepSignalError" ||
    err.name === "StaleExecutionBranchError"
  )
}

/**
 * Run `fn`, then `cleanUp` when the execution ends: it returns or it fails.
 * A control signal only parks the execution (for example to wait for a
 * child), and the run continues later, so it keeps its resources.
 *
 * A failed execution can be stale: another execution took the run when the
 * lease ran out (CTX-1080). The error does not tell this. For example,
 * OpenWorkflow refuses the completion of a step that was in progress when the
 * lease went. So after an error, `execution` reads the run. When another
 * execution has the run, this execution keeps the resources: the other
 * execution uses the same resources and cleans them up. In all other cases,
 * also when the read fails, the cleanup runs.
 */
export async function cleanUpUnlessParked<T>(
  fn: () => Promise<T>,
  cleanUp: () => Promise<void>,
  execution?: Pick<WorkflowExecution, "leaseState">,
): Promise<T> {
  let failed = false
  try {
    return await fn()
  } catch (error) {
    failed = true
    if (!isWorkflowControlSignal(error)) {
      const state = await execution?.leaseState().catch(() => "ended" as const)
      if (state !== "taken") await cleanUp()
    }
    throw error
  } finally {
    if (!failed) await cleanUp()
  }
}

/**
 * The values of child workflows that a run waits for with `allSettled`. A
 * child that still runs rejects with a control signal, so that signal goes
 * first: the run parks and waits. A failed child fails the run only when every
 * child has ended, so the run never cleans up while a sibling still runs.
 */
export function settledChildren<T>(settled: PromiseSettledResult<T>[]): T[] {
  const reasons = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  )
  const parked = reasons.find(isWorkflowControlSignal)
  if (parked !== undefined) throw parked
  if (reasons.length > 0) throw reasons[0]
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  )
}
