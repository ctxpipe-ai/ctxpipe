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

// --- Logger context (AsyncLocalStorage + getLogger) ---

export const loggerStorage = new AsyncLocalStorage<RequestLogger>()

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
 * Flush the current workflow/job logger to stdout/drain immediately.
 * `createLogger` buffers `set`/`info` until `emit()`; `withLogger` only
 * emits in `finally`, so long-running workflows would otherwise show no logs
 * until completion. Call after milestone `info`/`set` calls in workers.
 */
export function flushWorkflowLog(): void {
  const log = loggerStorage.getStore()
  if (log) log.emit()
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
    const log = ctx?.var?.log
    if (log) return log
  } catch {
    // Not in Hono context
  }
  throw new Error(
    "getLogger: no logger in context. Ensure you are in a Hono request or within withLogger().",
  )
}

export { createLogger, log }
