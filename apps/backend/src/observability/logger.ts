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
import { logFieldsFromActiveSpan } from "./logContract.js"
import {
  forceFlushOtel,
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
  otelServiceName,
} from "./otel.js"
import { flattenDbErrorCause } from "./scrubDbError.js"

/**
 * Paths and token/params patterns are the review list. The query pattern is
 * extra: logs must not keep `?…` (ADR-011). Built-ins stay off so ids are
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
    /\?[^#\s]*/g,
  ],
}

const wrappedConsoles = new WeakSet<object>()

function scrubLoggedArg(arg: unknown): unknown {
  if (typeof arg !== "string" || !arg.startsWith("{")) return arg
  try {
    const parsed = JSON.parse(arg) as Record<string, unknown>
    if (
      typeof parsed.level !== "string" ||
      typeof parsed.timestamp !== "string"
    ) {
      return arg
    }
    flattenDbErrorCause(parsed)
    return JSON.stringify(parsed)
  } catch {
    return arg
  }
}

/**
 * evlog writes stdout inside `emit`, before Hono `enrich`. Cause fields are
 * still a raw Error at that point, so scrub the JSON line on the way out.
 */
function installEvlogStdoutScrub(): void {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const current = console[method]
    if (wrappedConsoles.has(current)) continue
    const original = current.bind(console)
    const wrapped = (...args: unknown[]) => {
      original(...args.map(scrubLoggedArg))
    }
    wrappedConsoles.add(wrapped)
    console[method] = wrapped as (typeof console)[typeof method]
  }
}

function prepareOtlpEvent(event: Record<string, unknown>): void {
  flattenDbErrorCause(event)
  delete event.environment
  delete event.service
  delete event["service.namespace"]
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

type EvlogDrain = ((ctx: DrainContext | DrainContext[]) => Promise<void>) & {
  flush?: () => Promise<void>
}

let evlogDrainInstance: EvlogDrain | undefined
const inflightOtlp = new Set<Promise<void>>()

/**
 * OTLP drain for Hono and `initLogger`. Unset logs endpoint → stdout only.
 * `createOTLPDrain` reads `OTEL_EXPORTER_OTLP_HEADERS` itself. Timeout is 5s.
 */
export function createEvlogDrain(): EvlogDrain | undefined {
  if (evlogDrainInstance) return evlogDrainInstance
  const endpoint = otlpLogsEndpoint()
  if (!endpoint) return undefined
  const send = createOTLPDrain({
    endpoint,
    serviceName: otelServiceName(),
    resourceAttributes: {
      "service.namespace": "ctxpipe",
      "deployment.environment": otelDeploymentEnvironment(),
    },
    timeout: 5_000,
  })
  const drain: EvlogDrain = async (ctx) => {
    const items = Array.isArray(ctx) ? ctx : [ctx]
    for (const item of items) {
      prepareOtlpEvent(item.event as Record<string, unknown>)
    }
    const run = send(ctx)
    inflightOtlp.add(run)
    try {
      await run
    } finally {
      inflightOtlp.delete(run)
    }
  }
  evlogDrainInstance = drain
  return drain
}

/** Initialize evlog. Call early in app bootstrap. Reads env from process.env. */
export function initEvlog(options?: { silent?: boolean }): void {
  installEvlogStdoutScrub()
  if (options?.silent) {
    initLogger({
      env: {
        service: otelServiceName(),
        environment: otelDeploymentEnvironment(),
      },
      pretty: false,
      silent: true,
      redact: evlogRedact,
      drain: async () => {},
    })
    return
  }
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initLogger({
    env: {
      service: otelServiceName(env.OTEL_SERVICE_NAME),
      environment: otelDeploymentEnvironment(),
    },
    pretty: env.NODE_ENV === "development",
    redact: evlogRedact,
    drain: createEvlogDrain(),
  })
}

/** Flush in-flight OTLP log exports. Call on server shutdown. */
export async function flushEvlog(): Promise<void> {
  const waiting = [...inflightOtlp]
  evlogDrainInstance = undefined
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
        if (current) current.set(logFieldsFromActiveSpan())
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
  current.set(logFieldsFromActiveSpan())
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
