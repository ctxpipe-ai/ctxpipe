import { trace } from "@opentelemetry/api"
import { type OTLPLogRecord, toOTLPLogRecord } from "evlog/otlp"
import { ATTRIBUTION_KEYS, readAttribution } from "./attribution.js"
import { applyScrubDbErrors } from "./scrubDbError.js"
import { applyRedactedSecretPaths } from "./secretPath.js"
import { stripLogPii } from "./stripLogPii.js"

export { stripLogPii }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Resource identity and the TraceId/SpanId columns. evlog stringifies the
 * whole event into the log body, so these must be removed after
 * `toOTLPLogRecord` or HyperDX shows `environment` next to
 * `deployment.environment`.
 */
const BODY_KEYS_OWNED_ELSEWHERE = [
  "environment",
  "service",
  "service.namespace",
  "traceId",
  "spanId",
] as const

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
 * evlog's OTLP record copies top-level `traceId` / `spanId` onto the log
 * record columns and omits them from attributes. Nested-only attributes leave
 * HyperDX TraceId empty. `environment` and `service` stay off the event:
 * the drain's resource carries `deployment.environment` and `service.name`.
 */
export function applyLogContract(
  event: Record<string, unknown>,
  spanContext?: { traceId: string; spanId: string },
): void {
  stripLogPii(event)
  applyRedactedSecretPaths(event)
  applyScrubDbErrors(event)

  moveAlias(event, "requestId", "request.id")
  moveAlias(event, "method", "http.request.method")
  moveAlias(event, "path", "url.path")
  moveAlias(event, "orgId", "ctxpipe.org.id")
  moveAlias(event, "orgSlug", "ctxpipe.org.slug")

  // `status` is this service's response only when the event is an access log.
  // A downstream code uses `upstream.status_code` and stays off this key.
  const recordsOwnResponse =
    event["url.path"] != null || event["http.request.method"] != null
  if (recordsOwnResponse) {
    const status = event.status
    if (
      (typeof status === "number" || typeof status === "string") &&
      event["http.response.status_code"] == null
    ) {
      event["http.response.status_code"] = status
    }
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

/** Drop resource and trace-column fields from the JSON body evlog embeds. */
export function canonicalizeOtlpLogRecord(
  record: OTLPLogRecord,
): OTLPLogRecord {
  const raw = record.body?.stringValue
  if (!raw.startsWith("{")) return record
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of BODY_KEYS_OWNED_ELSEWHERE) delete parsed[key]
    record.body = { stringValue: JSON.stringify(parsed) }
  } catch {
    return record
  }
  return record
}

export function otlpLogsPayload(
  events: Record<string, unknown>[],
  resource: Record<string, string>,
) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: Object.entries(resource).map(([key, value]) => ({
            key,
            value: { stringValue: value },
          })),
        },
        scopeLogs: [
          {
            scope: { name: "evlog", version: "1.0.0" },
            logRecords: events.map((event) =>
              canonicalizeOtlpLogRecord(
                toOTLPLogRecord(event as Parameters<typeof toOTLPLogRecord>[0]),
              ),
            ),
          },
        ],
      },
    ],
  }
}
