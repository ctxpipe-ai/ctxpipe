import { AsyncLocalStorage } from "node:async_hooks"
import { context, propagation, trace } from "@opentelemetry/api"
import {
  createLogger,
  type DrainContext,
  initLogger,
  log,
  type RequestLogger,
} from "evlog"
import { type OTLPLogRecord, toOTLPLogRecord } from "evlog/otlp"
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { ATTRIBUTION_KEYS, stripLogPii } from "./contract.js"
import {
  forceFlushOtel,
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
  otelResourceAttributes,
  otelServiceName,
} from "./otel.js"
import { applyScrubDbErrors } from "./scrubDbError.js"
import { applyRedactedSecretPaths } from "./secretPath.js"

/**
 * Initialize evlog. Call early in app bootstrap.
 * Reads env from process.env.
 */
export function initEvlog(): void {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const serviceName = otelServiceName(env.OTEL_SERVICE_NAME)
  initLogger({
    env: {
      service: serviceName,
      environment: otelDeploymentEnvironment(),
    },
    pretty: env.NODE_ENV === "development",
    drain: createEvlogDrain(),
  })
}

let evlogDrainInstance: PipelineDrainFn<DrainContext> | undefined

/**
 * Create evlog drain for Hono. When OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set,
 * returns an OTLP drain with batching and retry. Otherwise returns undefined (stdout only).
 * Reads env from process.env. Caches and returns the same instance on repeated calls.
 */
export function createEvlogDrain() {
  if (evlogDrainInstance) return evlogDrainInstance
  const env = parseEnv(process.env as Record<string, string | undefined>)
  if (!env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return undefined

  // evlog appends /v1/logs; strip it so OTEL_EXPORTER_OTLP_LOGS_ENDPOINT can use full URL
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.replace(
    /\/v1\/logs\/?$/i,
    "",
  ).replace(/\/$/, "")

  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const serviceName = otelServiceName(env.OTEL_SERVICE_NAME)
  const baseDrain = async (ctx: DrainContext | DrainContext[]) => {
    const contexts = Array.isArray(ctx) ? ctx : [ctx]
    const events = contexts.map((item) => item.event)
    if (events.length === 0) return
    const payload = otlpLogsPayload(
      events,
      otelResourceAttributes(serviceName, otelDeploymentEnvironment()),
    )
    const response = await fetch(`${baseEndpoint}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(`OTLP logs HTTP ${response.status}`)
    }
  }

  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5000 },
    retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1000 },
    onDropped: (events, error) => {
      log.error({
        step: "evlog.pipeline",
        droppedEventCount: events.length,
        message: `[evlog] Dropped ${events.length} events`,
        error:
          error instanceof Error
            ? error.message
            : error != null
              ? String(error)
              : undefined,
      })
    },
  })

  evlogDrainInstance = pipeline(baseDrain)
  return evlogDrainInstance
}

/** Flush buffered evlog events. Call on server shutdown. */
export async function flushEvlog(): Promise<void> {
  if (evlogDrainInstance?.flush) {
    await evlogDrainInstance.flush()
    evlogDrainInstance = undefined
  }
}

function parseOtelHeaders(
  headerStr: string | undefined,
): Record<string, string> {
  if (!headerStr?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of headerStr.split(",")) {
    const eq = part.indexOf("=")
    if (eq > 0) {
      const key = part.slice(0, eq).trim()
      const value = part
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      if (key && value) out[key] = decodeURIComponent(value)
    }
  }
  return out
}

/** Top-level traceId/spanId become the OTLP log record TraceId/SpanId. */
export function applyCodesearchLogContract(
  event: Record<string, unknown>,
): void {
  stripLogPii(event)
  applyRedactedSecretPaths(event)
  applyScrubDbErrors(event)

  moveAlias(event, "requestId", "request.id")
  moveAlias(event, "method", "http.request.method")
  moveAlias(event, "path", "url.path")
  moveAlias(event, "orgId", "ctxpipe.org.id")
  moveAlias(event, "orgSlug", "ctxpipe.org.slug")
  const status = event.status
  if (
    (typeof status === "number" || typeof status === "string") &&
    event["http.response.status_code"] == null
  ) {
    event["http.response.status_code"] = status
  }
  delete event.status
  if (isRecord(event.user) && typeof event.user.id === "string") {
    if (event["enduser.id"] == null) event["enduser.id"] = event.user.id
    delete event.user.id
    if (Object.keys(event.user).length === 0) delete event.user
  }
  moveAlias(event, "userId", "enduser.id")

  const spanContext = trace.getActiveSpan()?.spanContext()
  if (spanContext?.traceId && typeof event.traceId !== "string") {
    event.traceId = spanContext.traceId
    event.spanId = spanContext.spanId
  }
  const baggage = propagation.getBaggage(context.active())
  if (baggage) {
    for (const key of ATTRIBUTION_KEYS) {
      const value = baggage.getEntry(key)?.value
      if (value && event[key] == null) event[key] = value
    }
  }
  delete event.environment
  delete event.service
  delete event["service.namespace"]
}

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

const BODY_KEYS_OWNED_ELSEWHERE = [
  "environment",
  "service",
  "service.namespace",
  "traceId",
  "spanId",
] as const

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

function otlpLogsPayload(
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

// --- Logger context (AsyncLocalStorage + getLogger) ---

export const loggerStorage = new AsyncLocalStorage<RequestLogger>()

/** Base workflow fields preserved across milestone flushes inside `withLogger`. */
const workflowBaseContext = new AsyncLocalStorage<Record<string, unknown>>()

function workflowLoggerHasMilestoneContent(logger: RequestLogger): boolean {
  const ctx = logger.getContext()
  if (ctx.step != null) return true
  const requestLogs = ctx.requestLogs
  return Array.isArray(requestLogs) && requestLogs.length > 0
}

/**
 * Run handler with logger in AsyncLocalStorage. Calls logger.emit() in finally.
 * Use for non-HTTP contexts (background jobs, etc.).
 */
export async function withLogger<T>(
  logger: RequestLogger,
  handler: () => Promise<T>,
): Promise<T> {
  const baseContext = { ...logger.getContext() }
  return workflowBaseContext.run(baseContext, () =>
    loggerStorage.run(logger, async () => {
      try {
        return await handler()
      } finally {
        const current = loggerStorage.getStore()
        if (current) {
          const spanContext = trace.getActiveSpan()?.spanContext()
          if (spanContext?.traceId) {
            current.set({
              traceId: spanContext.traceId,
              spanId: spanContext.spanId,
            })
          }
        }
        if (current && workflowLoggerHasMilestoneContent(current)) {
          current.emit()
        }
        if (isRailwayPrEnvironment()) {
          await forceFlushOtel()
        }
      }
    }),
  )
}

/**
 * Flush the current workflow/job logger to stdout/drain immediately.
 * After emit the logger is sealed; this rotates a fresh logger (same base
 * workflow context) into AsyncLocalStorage so later `getLogger()` calls work.
 */
export function flushWorkflowLog(): void {
  const current = loggerStorage.getStore()
  const base = workflowBaseContext.getStore()
  if (!current) return
  current.emit()
  if (base) {
    loggerStorage.enterWith(createLogger({ ...base }))
  }
}

/**
 * Get the current logger from AsyncLocalStorage (worker) or Hono context (HTTP).
 * @throws if neither context has a logger
 */
export function getLogger(): RequestLogger {
  const fromStorage = loggerStorage.getStore()
  if (fromStorage) return fromStorage
  try {
    const ctx = getContext<AppEnv>()
    const logger = ctx?.var?.log
    if (logger) return logger
  } catch {
    // Not in Hono context
  }
  throw new Error(
    "getLogger: no logger in context. Ensure you are in a Hono request or within withLogger().",
  )
}

export { createLogger, log }
