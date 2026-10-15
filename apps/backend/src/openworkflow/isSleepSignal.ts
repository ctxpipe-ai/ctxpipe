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
 */
export async function cleanUpUnlessParked<T>(
  fn: () => Promise<T>,
  cleanUp: () => Promise<void>,
): Promise<T> {
  let parked = false
  try {
    return await fn()
  } catch (error) {
    parked = isWorkflowControlSignal(error)
    throw error
  } finally {
    if (!parked) await cleanUp()
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
