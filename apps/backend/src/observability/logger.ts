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

const inflightOtlp = new Set<Promise<void>>()

function otlpDrain(): ((ctx: DrainContext) => Promise<void>) | undefined {
  const endpoint = otlpLogsEndpoint()
  if (!endpoint) return undefined
  return createOTLPDrain({
    endpoint,
    serviceName: otelServiceName(),
    resourceAttributes: {
      "service.namespace": "ctxpipe",
      "deployment.environment": otelDeploymentEnvironment(),
    },
    timeout: 5_000,
  })
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
  initLogger({
    env: {
      service: otelServiceName(env.OTEL_SERVICE_NAME),
      environment: envFields.environment,
    },
    pretty,
    silent: !pretty,
    redact: evlogRedact,
    drain: async (ctx) => {
      applyLogContract(ctx.event)
      if (!pretty) process.stdout.write(`${JSON.stringify(ctx.event)}\n`)
      if (!otlp) return
      const run = otlp(ctx)
      inflightOtlp.add(run)
      try {
        await run
      } finally {
        inflightOtlp.delete(run)
      }
    },
  })
}

/** Flush in-flight OTLP log exports. Call on server shutdown. */
export async function flushEvlog(): Promise<void> {
  const waiting = [...inflightOtlp]
  if (waiting.length === 0) return
  try {
    await Promise.all(waiting)
  } catch (error) {
    log.error({
      step: "evlog.pipeline",
      message: "evlog flush failed",
      error: error instanceof Error ? error.message : String(error),
    })
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
 * Use for OpenWorkflow and other non-HTTP contexts.
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
 * `createLogger` buffers `set`/`info` until `emit()`; `withLogger` only
 * emits in `finally`, so long-running workflows would otherwise show no logs
 * until completion. Call after milestone `info`/`set` calls in workers.
 *
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
