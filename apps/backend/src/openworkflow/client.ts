import { OpenWorkflow } from "openworkflow"

import { attachJobTelemetryForSchema } from "../observability/jobTelemetry.js"
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

/**
 * Prefer this over `ow.runWorkflow`: it attaches the job telemetry to the
 * input and checks that a reused idempotency key belongs to this workflow
 * version.
 */
export function enqueueWorkflow(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const [spec, input, options] = args
  return ow
    .runWorkflow(
      spec,
      attachJobTelemetryForSchema(spec.schema, input) as typeof input,
      options,
    )
    .then((handle) => assertNativeWorkflowVersion(spec, handle))
}
