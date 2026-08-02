import { flushWorkflowLog, getLogger } from "../observability/logger.js"

/**
 * Wraps an async workflow step fn; on throw, logs the failure to evlog (with
 * structured fields) and flushes the workflow log before rethrowing.
 *
 * SleepSignal is never treated as an attempt failure — it is rethrown silently
 * because it is a workflow control signal, not a real error.
 */
export async function withLoggedStepAttempt<T>(
  stepName: string,
  context: { repositoryId?: string; orgId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "SleepSignal") {
      throw err
    }
    const normalized = err instanceof Error ? err : new Error(String(err))
    getLogger().error(normalized, {
      step: `repository-ingestion.step.${stepName}.attempt_failed`,
      workflow: "repository-ingestion",
      stepName,
      repositoryId: context.repositoryId,
      orgId: context.orgId,
      errMessage: normalized.message,
      errName: normalized.name,
      stack: normalized.stack?.slice(0, 1000),
    })
    flushWorkflowLog()
    throw err
  }
}
