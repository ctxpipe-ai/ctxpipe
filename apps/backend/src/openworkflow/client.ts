import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { attachJobTelemetry } from "../observability/jobTelemetry.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
const backend = await BackendPostgres.connect(databaseUrl, {
  namespaceId: openWorkflowNamespaceId(),
})
export const ow = new OpenWorkflow({ backend })

export function closeOpenWorkflowClient(): Promise<void> {
  return backend.stop()
}

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export function runWorkflowWithWorkerWake(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const [spec, input, options] = args
  const queued = ow.runWorkflow(
    spec,
    attachJobTelemetry(input) as typeof input,
    options,
  )
  // Swallow the side-promise rejection. Callers observe the same failure on `queued`.
  void queued.then(
    () => {
      scheduleEnsureWorkerRunning()
    },
    () => undefined,
  )
  return queued
}
