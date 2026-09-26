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
  const nextInput = attachJobTelemetry(input)
  const run = () => ow.runWorkflow(spec, nextInput as typeof input, options)
  if (!trace.getActiveSpan()) {
    const queued = run()
    void queued.then(() => {
      scheduleEnsureWorkerRunning()
    })
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
        const queued = await run()
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
