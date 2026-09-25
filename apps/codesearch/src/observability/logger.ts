import { AsyncLocalStorage } from "node:async_hooks"
import { context, propagation, trace } from "@opentelemetry/api"
import {
  createLogger,
  type DrainContext,
  initLogger,
  log,
  type RequestLogger,
} from "evlog"
import { createOTLPDrain } from "evlog/otlp"
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { ATTRIBUTION_KEYS, stripLogPii } from "./contract.js"
import {
  forceFlushOtel,
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
} from "./otel.js"
import { applyRedactedSecretPaths } from "./secretPath.js"

/**
 * Initialize evlog. Call early in app bootstrap.
 * Reads env from process.env.
 */
export function initEvlog(): void {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const serviceName = env.OTEL_SERVICE_NAME ?? "codesearch"
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

  const baseDrain = createOTLPDrain({
    endpoint: baseEndpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? "codesearch",
    headers: parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    resourceAttributes: { "service.namespace": "ctxpipe" },
  })

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

  if (typeof event.requestId === "string" && event["request.id"] == null) {
    event["request.id"] = event.requestId
  }
  delete event.requestId
  if (typeof event.userId === "string" && event["enduser.id"] == null) {
    event["enduser.id"] = event.userId
  }
  delete event.userId

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
  event.environment = otelDeploymentEnvironment()
  event["service.namespace"] = "ctxpipe"
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
              environment: otelDeploymentEnvironment(),
              "service.namespace": "ctxpipe",
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
