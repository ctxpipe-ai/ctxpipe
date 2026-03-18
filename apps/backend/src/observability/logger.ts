import { AsyncLocalStorage } from "node:async_hooks"
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

/**
 * Initialize evlog. Call early in app bootstrap.
 * Reads env from process.env.
 */
export function initEvlog(): void {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-backend"
  initLogger({
    env: {
      service: serviceName,
      environment: env.NODE_ENV,
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
    serviceName: env.OTEL_SERVICE_NAME ?? "ctxpipe-backend",
    headers: parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  })

  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5000 },
    retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1000 },
    onDropped: (events, error) => {
      log.error({
        area: "observability",
        action: "evlog_dropped_events",
        droppedEventCount: events.length,
        error: error?.message ?? "Unknown evlog drain error",
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

// --- Logger context (AsyncLocalStorage + getLogger) ---

export const loggerStorage = new AsyncLocalStorage<RequestLogger>()
let hasLoggedMissingLoggerContext = false

type LoggerContext = Parameters<RequestLogger["set"]>[0]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeLoggerContext(
  target: Record<string, unknown>,
  source: LoggerContext | undefined,
): void {
  if (!source || !isPlainObject(source)) return

  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeLoggerContext(existing, value)
      continue
    }
    target[key] = value
  }
}

function createFallbackLogger(): RequestLogger {
  const context: Record<string, unknown> = {
    loggerFallback: true,
  }

  return {
    set(update) {
      mergeLoggerContext(context, update)
    },
    error(error, update) {
      mergeLoggerContext(context, update)
      log.error({
        ...context,
        error: error instanceof Error ? error.message : error,
      })
    },
    info(message, update) {
      mergeLoggerContext(context, update)
      log.info({
        ...context,
        message,
      })
    },
    warn(message, update) {
      mergeLoggerContext(context, update)
      log.warn({
        ...context,
        message,
      })
    },
    emit(overrides) {
      mergeLoggerContext(context, overrides)
      log.info({
        ...context,
        action: "fallback_logger_emit",
      })
      return null
    },
    getContext() {
      return { ...context }
    },
  }
}

/**
 * Run handler with logger in AsyncLocalStorage. Calls logger.emit() in finally.
 * Use for OpenWorkflow and other non-HTTP contexts.
 */
export async function withLogger<T>(
  logger: RequestLogger,
  handler: () => Promise<T>,
): Promise<T> {
  try {
    return await loggerStorage.run(logger, () => handler())
  } finally {
    logger.emit()
  }
}

/**
 * Get the current logger from AsyncLocalStorage (worker) or Hono context (HTTP).
 * Falls back to a generic evlog-backed logger when no request/workflow logger exists.
 */
export function getLogger(): RequestLogger {
  const fromStorage = loggerStorage.getStore()
  if (fromStorage) return fromStorage
  try {
    const ctx = getContext<AppEnv>()
    const log = ctx?.var?.log
    if (log) return log
  } catch {
    // Not in Hono context
  }
  if (!hasLoggedMissingLoggerContext) {
    log.info({
      area: "observability",
      action: "logger_context_missing",
      message:
        "Falling back to a generic evlog logger because no request/workflow logger was initialized.",
    })
    hasLoggedMissingLoggerContext = true
  }
  return createFallbackLogger()
}

export { createLogger }
