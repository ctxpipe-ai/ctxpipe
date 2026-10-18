import { BackendPostgres } from "openworkflow/postgres"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * Postgres refuses a NUL character and a lone surrogate in a jsonb value.
 * Remove each NUL and replace each lone surrogate with U+FFFD, in keys and
 * in values. The JSON round trip keeps the form that Postgres stores (for
 * example, a Date becomes its ISO string).
 */
function storable<T>(value: T): T {
  if (value === undefined) return value
  const clean = (text: string) => text.replaceAll("\u0000", "").toWellFormed()
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item === "string") return clean(item)
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [clean(key), entry]),
      )
    return item
  })
}

/**
 * Connect the OpenWorkflow backend of the app and the worker. A step or a
 * workflow can fail with, or return, text that Postgres refuses (for example
 * a file that holds a NUL byte). Without this, the write of the outcome
 * fails and hides the real error.
 */
export async function connectOpenWorkflowBackend(
  databaseUrl: string,
): Promise<BackendPostgres> {
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  const completeStep = backend.completeStepAttempt.bind(backend)
  const failStep = backend.failStepAttempt.bind(backend)
  const completeRun = backend.completeWorkflowRun.bind(backend)
  const failRun = backend.failWorkflowRun.bind(backend)
  const rescheduleRun =
    backend.rescheduleWorkflowRunAfterFailedStepAttempt.bind(backend)
  backend.completeStepAttempt = (params) =>
    completeStep({ ...params, output: storable(params.output) })
  backend.failStepAttempt = (params) =>
    failStep({ ...params, error: storable(params.error) })
  backend.completeWorkflowRun = (params) =>
    completeRun({ ...params, output: storable(params.output) })
  backend.failWorkflowRun = (params) =>
    failRun({ ...params, error: storable(params.error) })
  backend.rescheduleWorkflowRunAfterFailedStepAttempt = (params) =>
    rescheduleRun({ ...params, error: storable(params.error) })
  return backend
}
