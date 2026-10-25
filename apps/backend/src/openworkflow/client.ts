import { OpenWorkflow } from "openworkflow"

import { attachJobTelemetryForSchema } from "../observability/jobTelemetry.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
const backend = await connectOpenWorkflowBackend(databaseUrl)
export const ow = new OpenWorkflow({ backend })

export function closeOpenWorkflowClient(): Promise<void> {
  return backend.stop()
}

function assertNativeWorkflowVersion(
  spec: Parameters<typeof ow.runWorkflow>[0],
  handle: Awaited<ReturnType<typeof ow.runWorkflow>>,
): Awaited<ReturnType<typeof ow.runWorkflow>> {
  // Native idempotency is name/key scoped and can return a prior version.
  if (
    handle.workflowRun.workflowName !== spec.name ||
    handle.workflowRun.version !== (spec.version ?? null)
  )
    throw new Error(
      "Native workflow key belongs to a different workflow version",
    )
  return handle
}

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export function runWorkflowWithWorkerWake(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const [spec, input, options] = args
  const queued = ow
    .runWorkflow(
      spec,
      attachJobTelemetryForSchema(spec.schema, input) as typeof input,
      options,
    )
    .then((handle) => assertNativeWorkflowVersion(spec, handle))
  // Swallow the side-promise rejection. Callers observe the same failure on `queued`.
  // A repeated idempotency key can return a run that a worker already holds
  // or finished. Wake the worker only for a pending run; the wake debounce
  // limits repeats.
  void queued.then(
    (handle) => {
      if (handle.workflowRun.status === "pending") scheduleEnsureWorkerRunning()
    },
    () => undefined,
  )
  return queued
}
