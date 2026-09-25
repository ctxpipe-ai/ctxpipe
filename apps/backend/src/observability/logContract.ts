import { trace } from "@opentelemetry/api"
import { ATTRIBUTION_KEYS, readAttribution } from "./attribution.js"
import { otelDeploymentEnvironment } from "./otel.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * evlog's OTLP drain copies top-level `traceId` / `spanId` onto the log record
 * and maps `environment` to resource `deployment.environment`. Nested attributes
 * alone leave HyperDX TraceId empty.
 */
export function applyLogContract(
  event: Record<string, unknown>,
  spanContext?: { traceId: string; spanId: string },
): void {
  stripLogPii(event)

  if (typeof event.requestId === "string" && event["request.id"] == null) {
    event["request.id"] = event.requestId
  }
  delete event.requestId

  if (isRecord(event.user) && typeof event.user.id === "string") {
    if (event["enduser.id"] == null) event["enduser.id"] = event.user.id
  }
  if (typeof event.userId === "string" && event["enduser.id"] == null) {
    event["enduser.id"] = event.userId
  }
  delete event.userId

  const active = spanContext ?? trace.getActiveSpan()?.spanContext()
  if (active?.traceId && typeof event.traceId !== "string") {
    event.traceId = active.traceId
    event.spanId = active.spanId
  }

  const bag = readAttribution()
  for (const key of ATTRIBUTION_KEYS) {
    const value = bag[key]
    if (value && event[key] == null) event[key] = value
  }

  event.environment = otelDeploymentEnvironment()
  event["service.namespace"] = "ctxpipe"
}

export function stripLogPii(event: Record<string, unknown>): void {
  if (isRecord(event.user)) {
    delete event.user.email
    delete event.user.name
    delete event.user.image
  }
  if (isRecord(event.session)) {
    delete event.session.ipAddress
    delete event.session.userAgent
  }
  delete event.userAgent
  delete event.email
  delete event.ipAddress
  if (isRecord(event.headers)) {
    delete event.headers["user-agent"]
    delete event.headers["User-Agent"]
  }
}

export function logFieldsFromActiveSpan(): Record<string, string> {
  const fields: Record<string, string> = {
    environment: otelDeploymentEnvironment(),
    "service.namespace": "ctxpipe",
  }
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (spanContext?.traceId) {
    fields.traceId = spanContext.traceId
    fields.spanId = spanContext.spanId
  }
  const bag = readAttribution()
  for (const key of ATTRIBUTION_KEYS) {
    const value = bag[key]
    if (value) fields[key] = value
  }
  return fields
}
