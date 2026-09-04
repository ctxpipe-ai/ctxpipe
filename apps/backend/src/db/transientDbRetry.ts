import type { Pool } from "pg"
import { log } from "../observability/logger.js"

const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
])

const TRANSIENT_CONNECTION_MESSAGE_RE =
  /connection terminated|connection.*closed|server closed the connection|ssl connection has been closed|cannot connect|connection reset|ECONNRESET|admin_shutdown|cannot_connect_now|timeout exceeded when trying to connect/i

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const withCode = error as { code?: unknown }
  return typeof withCode.code === "string" ? withCode.code : undefined
}

function aggregateErrorChildren(error: unknown): unknown[] {
  if (
    typeof AggregateError !== "undefined" &&
    error instanceof AggregateError &&
    Array.isArray(error.errors)
  ) {
    return error.errors
  }
  if (
    error &&
    typeof error === "object" &&
    "errors" in error &&
    Array.isArray((error as { errors: unknown }).errors)
  ) {
    return (error as { errors: unknown[] }).errors
  }
  return []
}

/**
 * Flatten nested causes and AggregateError.errors (Node dual-stack connect
 * failures put ETIMEDOUT on children, with empty top-level message/code).
 */
function collectErrors(error: unknown): unknown[] {
  const out: unknown[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current == null || seen.has(current)) continue
    seen.add(current)
    out.push(current)
    if (current instanceof Error && current.cause != null) {
      queue.push(current.cause)
    } else if (
      current &&
      typeof current === "object" &&
      "cause" in current &&
      (current as { cause?: unknown }).cause != null
    ) {
      queue.push((current as { cause: unknown }).cause)
    }
    for (const child of aggregateErrorChildren(current)) {
      queue.push(child)
    }
  }
  return out
}

/** True for dead/reset Postgres connections suitable for a single reconnect retry. */
export function isTransientDbConnectionError(error: unknown): boolean {
  for (const err of collectErrors(error)) {
    const code = errorCode(err)
    if (code && TRANSIENT_CONNECTION_CODES.has(code)) return true
    if (TRANSIENT_CONNECTION_MESSAGE_RE.test(errorMessage(err))) return true
  }
  return false
}

/**
 * Human-readable error for logs when top-level `Error.message` is empty
 * (common with Node `AggregateError` / dual-stack `ETIMEDOUT`).
 */
export function formatUnknownError(error: unknown): string {
  const parts: string[] = []
  for (const err of collectErrors(error)) {
    const msg = errorMessage(err).trim()
    const code = errorCode(err)
    if (msg) parts.push(code ? `${msg} (${code})` : msg)
    else if (code) parts.push(code)
  }
  if (parts.length === 0) return String(error)
  // Dedupe while preserving order
  return [...new Set(parts)].join("; ")
}

export type DbConnectionAcquisitionRetryOptions = {
  /** Retries after the first attempt (default 1 → 2 attempts total). */
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/** Pool-connect budget: one retry before returning a retryable 503 upstream. */
const POOL_CONNECTION_RETRY = {
  retries: 1,
  baseDelayMs: 250,
} as const

/** Startup can wait through a short database outage; request paths fail fast. */
export const DB_STARTUP_CONNECTION_RETRY = {
  retries: 12,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
} as const

const CONNECTION_SYSCALL_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
])

function stringProperty(error: unknown, property: string): string | undefined {
  if (!error || typeof error !== "object" || !(property in error)) {
    return undefined
  }
  const value = (error as Record<string, unknown>)[property]
  return typeof value === "string" ? value : undefined
}

/**
 * True only when Postgres could not establish a connection, before the query
 * was sent. Mid-query disconnects are deliberately excluded because replay
 * after an ambiguous commit can duplicate mutations, including mutations
 * hidden inside SELECT functions.
 */
export function isDbConnectionAcquisitionError(error: unknown): boolean {
  for (const err of collectErrors(error)) {
    const code = errorCode(err)
    const syscall = stringProperty(err, "syscall")
    if (syscall === "connect" && code && CONNECTION_SYSCALL_CODES.has(code)) {
      return true
    }
    if (
      errorMessage(err) === "timeout exceeded when trying to connect" &&
      stringProperty(err, "severity") === undefined &&
      stringProperty(err, "routine") === undefined
    ) {
      return true
    }
  }
  return false
}

/** Retries only failures that prove the query was never sent to Postgres. */
export async function withDbConnectionAcquisitionRetry<T>(
  run: () => Promise<T>,
  opts?: DbConnectionAcquisitionRetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? POOL_CONNECTION_RETRY.retries
  const baseDelayMs = opts?.baseDelayMs ?? POOL_CONNECTION_RETRY.baseDelayMs
  const maxDelayMs = opts?.maxDelayMs
  const maxAttempts = retries + 1
  let last: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await run()
    } catch (e) {
      last = e
      if (isDbConnectionAcquisitionError(e) && attempt < maxAttempts - 1) {
        const rawDelayMs = baseDelayMs * 2 ** attempt
        const delayMs =
          maxDelayMs == null ? rawDelayMs : Math.min(rawDelayMs, maxDelayMs)
        log.info({
          step: "db.connection_acquisition_retry",
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          message: formatUnknownError(e),
        })
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      throw e
    }
  }

  throw last
}

/**
 * Wrap `pool.query` so promise-based queries retry only when connection
 * acquisition failed before Postgres received the statement. Callback-style
 * queries are left unchanged.
 */
export function wrapPoolQueryWithConnectionAcquisitionRetry(
  pool: Pool,
  opts?: DbConnectionAcquisitionRetryOptions,
): void {
  const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown

  pool.query = ((...args: unknown[]) => {
    const maybeCallback = args.find((a) => typeof a === "function")
    if (maybeCallback) return originalQuery(...args)

    return withDbConnectionAcquisitionRetry(
      () => Promise.resolve(originalQuery(...args)),
      opts,
    )
  }) as typeof pool.query
}
