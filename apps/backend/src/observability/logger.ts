import { AsyncLocalStorage } from "node:async_hooks"

import { parseKeyPairsIntoRecord } from "@opentelemetry/core"
import {
  createLogger,
  type DrainContext,
  initLogger,
  log,
  type RedactConfig,
  type RequestLogger,
} from "evlog"
import { sendBatchToOTLP } from "evlog/otlp"
import { createDrainPipeline, type PipelineDrainFn } from "evlog/pipeline"
import { getContext } from "hono/context-storage"

import { isPreviewDeployment } from "../../../../shared/deployment-environment.js"
import type { AppEnv } from "../app/env.js"
import { ecsTaskId } from "./ecsTask.js"
import { exportFailureReport } from "./exportFailures.js"
import { applyLogContract } from "./logContract.js"
import {
  forceFlushOtel,
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
 * or unreachable collector costs dropped logs, never response latency, and
 * never a crash. A batch that fails three times is dropped, and
 * `exportFailureReport` logs the drops at most once a minute (CTX-1705).
 * The send is our own, not `createOTLPDrain`: that drain catches each
 * failure and writes it to `console.error` with a stack, once per batch, so
 * the pipeline never saw it.
 */
function otlpDrain(): PipelineDrainFn<DrainContext> | undefined {
  const endpoint = otlpLogsEndpoint()
  if (!endpoint) return undefined
  const reportFailure = exportFailureReport("logs")
  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5_000 },
    retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1_000 },
    onDropped: (events, error) => reportFailure(error, events.length),
  })
  const headers = parseKeyPairsIntoRecord(
    process.env.OTEL_EXPORTER_OTLP_HEADERS,
  )
  return pipeline(async (batch) => {
    const taskId = await ecsTaskId()
    await sendBatchToOTLP(
      batch.map((ctx) => ctx.event),
      {
        endpoint,
        headers,
        serviceName: otelServiceName(),
        resourceAttributes: {
          "service.namespace": "ctxpipe",
          "deployment.environment": otelDeploymentEnvironment(),
          ...(taskId ? { "service.instance.id": taskId } : {}),
        },
        timeout: 5_000,
        // The pipeline retries the batch; no retry inside the send.
        retries: 0,
      },
    )
  })
}

/** Initialize evlog. Call early in app bootstrap. Reads env from process.env. */
export function initEvlog(options?: {
  silent?: boolean
  stderr?: boolean
}): void {
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
  // The logger reads only its own settings, as `otel.ts` does: a script
  // with no database (the provider probe) can log too (CTX-1650). The
  // default of NODE_ENV is the one of `parseEnv`.
  const pretty =
    (process.env.NODE_ENV || "development") === "development" &&
    !options?.stderr
  otlpPipeline = otlpDrain()
  initLogger({
    env: envFields,
    pretty,
    silent: !pretty,
    redact: evlogRedact,
    // Synchronous so the contract reads the active span; the export is batched.
    drain: (ctx) => {
      applyLogContract(ctx.event)
      if (!pretty)
        (options?.stderr ? process.stderr : process.stdout).write(
          `${JSON.stringify(ctx.event)}\n`,
        )
      otlpPipeline?.(ctx)
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
      if (isPreviewDeployment(process.env)) {
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

/** The workflow name that `defineWorkflow` put on the workflow logger. */
export function currentWorkflowName(): string | undefined {
  const workflow = loggerStorage.getStore()?.base.workflow
  return typeof workflow === "string" ? workflow : undefined
}

/**
 * Get the current logger from AsyncLocalStorage (worker) or Hono context (HTTP).
 * @throws if neither context has a logger
 */
export function getLogger(): RequestLogger {
  const logger = currentLogger()
  if (logger) return logger
  throw new Error(
    "getLogger: no logger in context. Ensure you are in a Hono request or within withLogger().",
  )
}

function currentLogger(): RequestLogger | undefined {
  const fromStorage = loggerStorage.getStore()?.logger
  if (fromStorage) return fromStorage
  try {
    return getContext<AppEnv>()?.var?.log
  } catch {
    // Not in Hono context
    return undefined
  }
}

/**
 * The error log of work that a request or a job starts and does not wait
 * for. evlog emits the request event with the response, and drops a field
 * that comes later. Thus each error here is an event of its own, with the
 * step and the request id when there is one.
 */
export function detachedErrorLog(step: string): {
  error: (err: Error) => void
} {
  const requestId = currentLogger()?.getContext().requestId
  return {
    error: (err) => {
      const logger = createLogger({ step, requestId })
      logger.error(err)
      logger.emit()
    },
  }
}

export { createLogger, log }
