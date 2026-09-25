import {
  context,
  createContextKey,
  type Link,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { z } from "zod"
import { isWorkflowControlSignal } from "../openworkflow/isSleepSignal.js"
import {
  ATTRIBUTION_KEYS,
  type AttributionKey,
  applyAttribution,
  contextWithAttributionBag,
  readAttribution,
} from "./attribution.js"
import { recordTerminalConnectorSync } from "./businessMetrics.js"

const IN_OPENWORKFLOW_JOB = createContextKey("ctxpipe.openworkflow.job")

export const jobTelemetrySchema = z.object({
  traceparent: z.string().optional(),
  "request.id": z.string().optional(),
  "enduser.id": z.string().optional(),
  "ctxpipe.org.id": z.string().optional(),
  "ctxpipe.org.slug": z.string().optional(),
  /** Set when this run was enqueued from another job. Fan-out is not a second sync. */
  nested: z.boolean().optional(),
})

export type JobTelemetry = z.infer<typeof jobTelemetrySchema>

function traceparentFromActiveSpan(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (!spanContext?.traceId || !spanContext.spanId) return undefined
  const flags = (spanContext.traceFlags ?? 1).toString(16).padStart(2, "0")
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
}

export function jobSpanName(workflowName: string | undefined): string {
  const name = workflowName?.trim()
  return name ? `openworkflow.job ${name}` : "openworkflow.job"
}

export function captureJobTelemetry(): JobTelemetry | undefined {
  const bag = readAttribution()
  const telemetry: JobTelemetry = {}
  const traceparent = traceparentFromActiveSpan()
  if (traceparent) telemetry.traceparent = traceparent
  if (context.active().getValue(IN_OPENWORKFLOW_JOB) === true) {
    telemetry.nested = true
  }
  for (const key of [
    "request.id",
    "enduser.id",
    "ctxpipe.org.id",
    "ctxpipe.org.slug",
  ] as const) {
    const value = bag[key]
    if (value) telemetry[key] = value
  }
  if (
    !telemetry.traceparent &&
    !telemetry.nested &&
    !telemetry["request.id"] &&
    !telemetry["enduser.id"] &&
    !telemetry["ctxpipe.org.id"]
  ) {
    return undefined
  }
  return telemetry
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Fields from the job payload. Does not write them onto the caller's span. */
export function attributionPatchFromJobInput(
  input: unknown,
): Partial<Record<AttributionKey, string>> {
  if (!input || typeof input !== "object") return {}
  const record = input as Record<string, unknown>
  const patch: Partial<Record<AttributionKey, string>> = {}
  const orgId = stringField(record, "orgId")
  const orgSlug = stringField(record, "orgSlug")
  const connectionId =
    stringField(record, "connectionId") ??
    stringField(record, "githubConnectionId")
  const repositoryId = stringField(record, "repositoryId")
  if (orgId) patch["ctxpipe.org.id"] = orgId
  if (orgSlug) patch["ctxpipe.org.slug"] = orgSlug
  if (connectionId) patch["ctxpipe.connection.id"] = connectionId
  if (repositoryId) patch["ctxpipe.repository.id"] = repositoryId
  return patch
}

export function attachJobTelemetry<T>(
  input: T,
): T & { telemetry?: JobTelemetry } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input as T & { telemetry?: JobTelemetry }
  }
  const record = input as Record<string, unknown>
  if (record.telemetry && typeof record.telemetry === "object") {
    return input as T & { telemetry?: JobTelemetry }
  }
  const telemetry: JobTelemetry = { ...(captureJobTelemetry() ?? {}) }
  const orgId = stringField(record, "orgId")
  const orgSlug = stringField(record, "orgSlug")
  const capturedOrg = telemetry["ctxpipe.org.id"]
  if (orgId) telemetry["ctxpipe.org.id"] = orgId
  if (orgSlug) telemetry["ctxpipe.org.slug"] = orgSlug
  else if (orgId && capturedOrg && orgId !== capturedOrg) {
    delete telemetry["ctxpipe.org.slug"]
  }
  if (Object.keys(telemetry).length === 0) {
    return input as T & { telemetry?: JobTelemetry }
  }
  return { ...record, telemetry } as T & { telemetry: JobTelemetry }
}

/**
 * OpenWorkflow 0.8 parks with `SleepSignal` (`SleepSignalError` on 0.10+) and
 * stops a stale parallel branch with `StaleExecutionBranchError` (also how a
 * canceled run drops in-flight branches). `StepError` while attempts remain
 * only schedules a retry. Those must reach the worker unmarked.
 */
function isJobControlFlow(err: unknown): boolean {
  if (isWorkflowControlSignal(err)) return true
  if (!(err instanceof Error) || err.name !== "StepError") return false
  const step = err as Error & {
    stepFailedAttempts?: number
    retryPolicy?: { maximumAttempts?: number }
  }
  const maximumAttempts = step.retryPolicy?.maximumAttempts
  const attempts = step.stepFailedAttempts
  if (typeof maximumAttempts !== "number" || typeof attempts !== "number") {
    return true
  }
  if (maximumAttempts === 0) return true
  return attempts < maximumAttempts
}

function exceptionForSpan(err: unknown): Error {
  if (err instanceof Error && err.name === "StepError") {
    const original = (err as Error & { originalError?: unknown }).originalError
    if (original instanceof Error) return original
  }
  return err instanceof Error ? err : new Error(String(err))
}

export async function restoreJobTelemetry<T>(
  telemetry: JobTelemetry | undefined,
  fn: () => Promise<T>,
  input?: unknown,
  workflowName?: string,
): Promise<T> {
  const parsed = telemetry ? jobTelemetrySchema.safeParse(telemetry) : null
  const fields = parsed?.success ? parsed.data : {}
  const nested = fields.nested === true

  const links: Link[] = []
  if (fields.traceparent) {
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: fields.traceparent,
    })
    const linked = trace.getSpanContext(extracted)
    if (linked) links.push({ context: linked })
  }

  const { context: withBag } = contextWithAttributionBag(ROOT_CONTEXT)
  const bagPatch: Partial<Record<AttributionKey, string>> = {
    "ctxpipe.actor.type": "job",
  }
  for (const key of ATTRIBUTION_KEYS) {
    const value = fields[key as keyof JobTelemetry]
    if (typeof value === "string") bagPatch[key] = value
  }
  bagPatch["ctxpipe.actor.type"] = "job"
  const inputPatch = attributionPatchFromJobInput(input)
  if (
    inputPatch["ctxpipe.org.id"] &&
    inputPatch["ctxpipe.org.id"] !== bagPatch["ctxpipe.org.id"] &&
    !inputPatch["ctxpipe.org.slug"]
  ) {
    delete bagPatch["ctxpipe.org.slug"]
  }

  const tracer = trace.getTracer("ctxpipe-backend")
  const span = tracer.startSpan(
    jobSpanName(workflowName),
    {
      kind: SpanKind.CONSUMER,
      links,
    },
    withBag,
  )
  const spanContext = trace
    .setSpan(withBag, span)
    .setValue(IN_OPENWORKFLOW_JOB, true)
  return context.with(spanContext, async () => {
    applyAttribution(bagPatch)
    applyAttribution(inputPatch)
    try {
      const result = await fn()
      if (!nested) {
        recordTerminalConnectorSync(workflowName, input, "success")
      }
      return result
    } catch (error) {
      if (isJobControlFlow(error)) throw error
      if (!nested) {
        recordTerminalConnectorSync(workflowName, input, "failure")
      }
      const exception = exceptionForSpan(error)
      span.recordException(exception)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: exception.message,
      })
      throw error
    } finally {
      span.end()
    }
  })
}
