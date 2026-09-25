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

export function fillAttributionFromJobInput(input: unknown): void {
  if (!input || typeof input !== "object") return
  const record = input as Record<string, unknown>
  const current = readAttribution()
  const patch: Partial<Record<AttributionKey, string>> = {}
  const orgId = stringField(record, "orgId")
  const orgSlug = stringField(record, "orgSlug")
  const connectionId =
    stringField(record, "connectionId") ??
    stringField(record, "githubConnectionId")
  const repositoryId = stringField(record, "repositoryId")
  if (!current["ctxpipe.org.id"] && orgId) patch["ctxpipe.org.id"] = orgId
  if (!current["ctxpipe.org.slug"] && orgSlug)
    patch["ctxpipe.org.slug"] = orgSlug
  if (!current["ctxpipe.connection.id"] && connectionId) {
    patch["ctxpipe.connection.id"] = connectionId
  }
  if (!current["ctxpipe.repository.id"] && repositoryId) {
    patch["ctxpipe.repository.id"] = repositoryId
  }
  if (!current["ctxpipe.actor.type"] && connectionId) {
    patch["ctxpipe.actor.type"] = "webhook"
  }
  applyAttribution(patch)
}

export function attachJobTelemetry<T>(input: T): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  if (record.telemetry && typeof record.telemetry === "object") return input
  fillAttributionFromJobInput(input)
  const telemetry = captureJobTelemetry()
  if (!telemetry) return input
  return { ...record, telemetry } as T
}

export async function restoreJobTelemetry<T>(
  telemetry: JobTelemetry | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!telemetry) return fn()
  const parsed = jobTelemetrySchema.safeParse(telemetry)
  if (!parsed.success) return fn()
  const fields = parsed.data

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
    try {
      return await fn()
    } finally {
      span.end()
    }
  })
}
