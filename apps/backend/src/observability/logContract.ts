import { isSpanContextValid, trace } from "@opentelemetry/api"
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
 * `service` and `environment` stay on the event for stdout. The OTLP adapter
 * strips them; the resource carries service name and deployment environment.
 * `http.response.status_code` is this service's response. A downstream status
 * uses `upstream.status_code` and is left on `status`.
 */
export function applyLogContract(event: Record<string, unknown>): void {
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
  const current = trace.getActiveSpan()?.spanContext()
  const active = current && isSpanContextValid(current) ? current : undefined
  if (active?.traceId && typeof event.traceId !== "string") {
    event.traceId = active.traceId
    event.spanId = active.spanId
  }
  const bag = readAttribution()
  for (const key of ATTRIBUTION_KEYS) {
    const value = bag[key]
    if (value && event[key] == null) event[key] = value
  }
  delete event["service.namespace"]
}
