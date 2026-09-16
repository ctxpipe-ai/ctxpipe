/**
 * OpenWorkflow parks a parent run by throwing this control signal (not a
 * real failure). 0.8/0.9 used `SleepSignal`; 0.10+ renamed it to
 * `SleepSignalError`. Treat both as a park so ingest is not marked failed.
 */
export function isSleepSignal(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === "SleepSignal" || err.name === "SleepSignalError"
}
