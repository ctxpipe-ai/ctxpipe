import {
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from "@opentelemetry/api"
import { z } from "zod"
import {
  ATTRIBUTION_KEYS,
  type AttributionKey,
  applyAttribution,
  contextWithAttributionBag,
  readAttribution,
} from "./attribution.js"

export const jobTelemetrySchema = z.object({
  traceparent: z.string().optional(),
  "request.id": z.string().optional(),
  "enduser.id": z.string().optional(),
  "ctxpipe.org.id": z.string().optional(),
  "ctxpipe.org.slug": z.string().optional(),
})

export type JobTelemetry = z.infer<typeof jobTelemetrySchema>

function traceparentFromActiveSpan(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (!spanContext?.traceId || !spanContext.spanId) return undefined
  const flags = (spanContext.traceFlags ?? 1).toString(16).padStart(2, "0")
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
}

export function captureJobTelemetry(): JobTelemetry | undefined {
  const bag = readAttribution()
  const telemetry: JobTelemetry = {}
  const traceparent = traceparentFromActiveSpan()
  if (traceparent) telemetry.traceparent = traceparent
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

export function attachJobTelemetry<T extends object>(
  input: T,
): T & { telemetry?: JobTelemetry } {
  if (Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  if (record.telemetry && typeof record.telemetry === "object") return input
  const telemetry: JobTelemetry = { ...(captureJobTelemetry() ?? {}) }
  const orgId = stringField(record, "orgId")
  const orgSlug = stringField(record, "orgSlug")
  const capturedOrg = telemetry["ctxpipe.org.id"]
  if (orgId) telemetry["ctxpipe.org.id"] = orgId
  if (orgSlug) telemetry["ctxpipe.org.slug"] = orgSlug
  else if (orgId && capturedOrg && orgId !== capturedOrg) {
    delete telemetry["ctxpipe.org.slug"]
  }
  if (Object.keys(telemetry).length === 0) return input
  return { ...record, telemetry } as T & { telemetry: JobTelemetry }
}

export async function restoreJobTelemetry<T>(
  telemetry: JobTelemetry | undefined,
  fn: () => Promise<T>,
  input?: unknown,
): Promise<T> {
  const parsed = telemetry ? jobTelemetrySchema.safeParse(telemetry) : null
  const fields = parsed?.success ? parsed.data : {}

  let parent = ROOT_CONTEXT
  const links: Link[] = []
  if (fields.traceparent) {
    parent = propagation.extract(ROOT_CONTEXT, {
      traceparent: fields.traceparent,
    })
    const linked = trace.getSpanContext(parent)
    if (linked) links.push({ context: linked })
  }

  const { context: withBag } = contextWithAttributionBag(parent)
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
    "openworkflow.job",
    {
      kind: SpanKind.CONSUMER,
      links,
    },
    withBag,
  )
  const spanContext = trace.setSpan(withBag, span)
  return context.with(spanContext, async () => {
    applyAttribution(bagPatch)
    applyAttribution(inputPatch)
    try {
      return await fn()
    } finally {
      span.end()
    }
  })
}
