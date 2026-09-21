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
