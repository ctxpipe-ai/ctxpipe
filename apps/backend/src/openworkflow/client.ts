import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { recordEnqueuedWorkflow } from "../observability/businessMetrics.js"
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

function workflowNameOf(spec: unknown): string {
  return spec &&
    typeof spec === "object" &&
    "name" in spec &&
    typeof spec.name === "string"
    ? spec.name
    : ""
}

/** Prefer this over `ow.runWorkflow` so PR workers are woken on Railway after enqueue. */
export function runWorkflowWithWorkerWake(
  ...args: Parameters<typeof ow.runWorkflow>
): ReturnType<typeof ow.runWorkflow> {
  const [spec, input, options] = args
  const workflowName = workflowNameOf(spec)
  recordEnqueuedWorkflow(workflowName, input)
  const nextInput = attachJobTelemetry(input)
  const run = () => ow.runWorkflow(spec, nextInput as typeof input, options)
  if (!trace.getActiveSpan()) {
    const queued = run()
    void queued.then(() => {
      scheduleEnsureWorkerRunning()
    })
    return queued
  }

  const spanName = workflowName
    ? `openworkflow.enqueue ${workflowName}`
    : "openworkflow.enqueue"
  return trace.getTracer("ctxpipe-backend").startActiveSpan(
    spanName,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "db.system.name": "postgresql",
        "db.operation.name": "enqueue",
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
