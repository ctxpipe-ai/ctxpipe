import { AsyncLocalStorage } from "node:async_hooks"
import {
  createLogger,
  type DrainContext,
  initLogger,
  log,
  type RedactConfig,
  type RequestLogger,
} from "evlog"
import { createOTLPDrain } from "evlog/otlp"
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline"
import { getContext } from "hono/context-storage"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { applyLogContract } from "./logContract.js"
import {
  forceFlushOtel,
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
  otelServiceName,
} from "./otel.js"

/**
 * Paths and token/params patterns are the review list. The query pattern is
 * extra and only matches `?…` after `http(s)://…` or a `/` at the start of
 * the string or after whitespace (ADR-011). Built-ins stay off so ids are
 * not partially masked; emails are removed only on the paths below.
 */
const evlogRedact: RedactConfig = {
  builtins: false,
  paths: [
    "user.email",
    "user.name",
    "user.image",
    "session.ipAddress",
    "session.userAgent",
    "userAgent",
    "email",
    "ipAddress",
    "headers.user-agent",
  ],
  patterns: [
    /(?<=\/reset-password\/)[^/?#]+/g,
    /(?<=\/public\/invitations\/)[^/?#]+/g,
    /\r?\nparams:[^\r\n]*/g,
    /(?<=(?:https?:\/\/|(?:^|\s)\/)[^\s?#]*)\?[^#\s]*/g,
  ],
}

/**
 * evlog 2.14.1 reads `OTEL_EXPORTER_OTLP_ENDPOINT` and appends `/v1/logs`.
 * This service sets `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (often already suffixed).
 */
function otlpLogsEndpoint(): string | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
  if (!raw) return undefined
  return raw.replace(/\/v1\/logs\/?$/i, "").replace(/\/$/, "")
}

let otlpPipeline: PipelineDrainFn<DrainContext> | undefined

/**
 * Batches OTLP log exports off the request path. A push only buffers; a slow
 * or unreachable collector costs dropped logs, never response latency.
 */
function otlpDrain(): PipelineDrainFn<DrainContext> | undefined {
  const endpoint = otlpLogsEndpoint()
  if (!endpoint) return undefined
  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5_000 },
    retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1_000 },
    onDropped: (events, error) => {
      log.error({
        step: "evlog.pipeline",
        droppedEventCount: events.length,
        message: `[evlog] Dropped ${events.length} events`,
        error: error instanceof Error ? error.message : undefined,
      })
    },
  })
  return pipeline(
    createOTLPDrain({
      endpoint,
      serviceName: otelServiceName(),
      resourceAttributes: {
        "service.namespace": "ctxpipe",
        "deployment.environment": otelDeploymentEnvironment(),
      },
      timeout: 5_000,
    }),
  )
}

/** Initialize evlog. Call early in app bootstrap. Reads env from process.env. */
export function initEvlog(options?: { silent?: boolean }): void {
  const envFields = {
    service: otelServiceName(),
    environment: otelDeploymentEnvironment(),
  }
  if (options?.silent) {
    initLogger({
      env: envFields,
      pretty: false,
      silent: true,
      redact: evlogRedact,
      drain: async () => {},
    })
    return
  }
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const pretty = env.NODE_ENV === "development"
  const otlp = otlpDrain()
  otlpPipeline = otlp
  initLogger({
    env: {
      service: otelServiceName(env.OTEL_SERVICE_NAME),
      environment: envFields.environment,
    },
    pretty,
    silent: !pretty,
    redact: evlogRedact,
    // Synchronous so the contract reads the active span; the export is batched.
    drain: (ctx) => {
      applyLogContract(ctx.event)
      if (!pretty) process.stdout.write(`${JSON.stringify(ctx.event)}\n`)
      otlp?.(ctx)
    },
  })
}

/** Send buffered OTLP log exports. Call on shutdown and before a script exits. */
export async function flushEvlog(): Promise<void> {
  if (!otlpPipeline) return
  try {
    await otlpPipeline.flush()
  } catch (error) {
    log.error({
      step: "evlog.pipeline",
      message: "evlog flush failed",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// --- Logger context (AsyncLocalStorage + getLogger) ---

/**
 * The stored value is a mutable holder, not the logger: `flushWorkflowLog`
 * swaps `holder.logger`, and timers or branches created before the flush
 * share the holder, so they write to the fresh logger instead of the sealed
 * one.
 */
export type LoggerHolder = {
  logger: RequestLogger
  base: Record<string, unknown>
}

export const loggerStorage = new AsyncLocalStorage<LoggerHolder>()

function workflowLoggerHasMilestoneContent(logger: RequestLogger): boolean {
  const ctx = logger.getContext()
  if (ctx.step != null) return true
  const requestLogs = ctx.requestLogs
  return Array.isArray(requestLogs) && requestLogs.length > 0
}

/**
 * Run handler with logger in AsyncLocalStorage. Calls logger.emit() in finally.
 * Use for OpenWorkflow and other non-HTTP contexts.
 */
export async function withLogger<T>(
  logger: RequestLogger,
  handler: () => Promise<T>,
): Promise<T> {
  const holder: LoggerHolder = { logger, base: { ...logger.getContext() } }
  return loggerStorage.run(holder, async () => {
    try {
      return await handler()
    } finally {
      if (workflowLoggerHasMilestoneContent(holder.logger)) {
        holder.logger.emit()
      }
      if (isRailwayPrEnvironment()) {
        await forceFlushOtel()
      }
    }
  })
}

/**
 * Flush the current workflow/job logger to stdout/drain immediately.
 * `createLogger` buffers `set`/`info` until `emit()`; `withLogger` only
 * emits in `finally`, so long-running workflows would otherwise show no logs
 * until completion. Call after milestone `info`/`set` calls in workers.
 *
 * After emit the logger is sealed; this rotates a fresh logger (same base
 * workflow context) into the shared holder so later `getLogger()` calls work.
 */
export function flushWorkflowLog(): void {
  const holder = loggerStorage.getStore()
  if (!holder) return
  holder.logger.emit()
  holder.logger = createLogger({ ...holder.base })
}

/**
 * Get the current logger from AsyncLocalStorage (worker) or Hono context (HTTP).
 * @throws if neither context has a logger
 */
export function getLogger(): RequestLogger {
  const fromStorage = loggerStorage.getStore()?.logger
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
