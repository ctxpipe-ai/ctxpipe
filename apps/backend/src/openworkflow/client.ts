import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { attachJobTelemetry } from "../observability/jobTelemetry.js"
import { dbErrorException } from "../observability/scrubDbError.js"
import { openWorkflowNamespaceId } from "./namespace.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for OpenWorkflow client")
const backend = await BackendPostgres.connect(databaseUrl, {
  runMigrations: false,
  namespaceId: openWorkflowNamespaceId(),
})
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
  const enqueue = () =>
    ow
      .runWorkflow(spec, attachJobTelemetry(input) as typeof input, options)
      .then((handle) => assertNativeWorkflowVersion(spec, handle))
  if (!trace.getActiveSpan()) {
    const queued = enqueue()
    void queued.then(
      () => scheduleEnsureWorkerRunning(),
      // The caller observes the original enqueue rejection through queued.
      () => undefined,
    )
    return queued
  }

  return trace.getTracer("ctxpipe-backend").startActiveSpan(
    `openworkflow.enqueue ${spec.name}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "openworkflow",
        "messaging.operation.type": "send",
        "messaging.destination.name": spec.name,
      },
    },
    async (span) => {
      try {
        const queued = await enqueue()
        scheduleEnsureWorkerRunning()
        return queued
      } catch (error) {
        const sanitized = dbErrorException(error)
        span.recordException(sanitized)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: sanitized.message,
        })
        throw error
      } finally {
        span.end()
      }
    },
  )
}
