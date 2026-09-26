import { trace } from "@opentelemetry/api"
import { ATTRIBUTION_KEYS, readAttribution } from "./attribution.js"
import { flattenDbErrorCause } from "./scrubDbError.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function moveAlias(
  event: Record<string, unknown>,
  from: string,
  to: string,
): void {
  if (typeof event[from] === "string" && event[to] == null)
    event[to] = event[from]
  delete event[from]
}

/**
 * Canonical log keys (ADR-011). Redaction is `initLogger({ redact })`.
 * `environment` and `service` stay off the body; the OTLP resource carries them.
 * `http.response.status_code` is this service's response. A downstream status
 * uses `upstream.status_code` and is left on `status`.
 */
export function applyLogContract(
  event: Record<string, unknown>,
  spanContext?: { traceId: string; spanId: string },
): void {
  flattenDbErrorCause(event)
  moveAlias(event, "requestId", "request.id")
  moveAlias(event, "method", "http.request.method")
  moveAlias(event, "path", "url.path")
  moveAlias(event, "orgId", "ctxpipe.org.id")
  moveAlias(event, "orgSlug", "ctxpipe.org.slug")
  const ownResponse =
    event["url.path"] != null || event["http.request.method"] != null
  if (
    ownResponse &&
    (typeof event.status === "number" || typeof event.status === "string") &&
    event["http.response.status_code"] == null
  ) {
    event["http.response.status_code"] = event.status
    delete event.status
  }
  if (isRecord(event.user) && typeof event.user.id === "string") {
    if (event["enduser.id"] == null) event["enduser.id"] = event.user.id
    delete event.user.id
    if (Object.keys(event.user).length === 0) delete event.user
  }
  moveAlias(event, "userId", "enduser.id")
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
  delete event.environment
  delete event.service
  delete event["service.namespace"]
}

export function logFieldsFromActiveSpan(): Record<string, string> {
  const fields: Record<string, string> = {}
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
