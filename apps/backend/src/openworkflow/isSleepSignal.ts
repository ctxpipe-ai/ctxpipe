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
