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

export type WithTransientDbQueryRetryOptions = {
  /** Retries after the first attempt (default 3 → 4 attempts total). */
  retries?: number
  baseDelayMs?: number
}

/** Read-query budget: absorb a Neon wake or short reset without hanging a request. */
export const POOL_READ_RETRY = {
  retries: 3,
  baseDelayMs: 400,
} as const

/**
 * Retries `run` on transient Postgres connection failures (Neon idle
 * disconnect, reset, admin shutdown). Default budget is a few seconds so a
 * compute wake is absorbed without holding the caller for tens of seconds.
 */
export async function withTransientDbQueryRetry<T>(
  run: () => Promise<T>,
  opts?: WithTransientDbQueryRetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? POOL_READ_RETRY.retries
  const baseDelayMs = opts?.baseDelayMs ?? POOL_READ_RETRY.baseDelayMs
  const maxAttempts = retries + 1
  let last: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await run()
    } catch (e) {
      last = e
      if (isTransientDbConnectionError(e) && attempt < maxAttempts - 1) {
        const delayMs = baseDelayMs * 2 ** attempt
        log.info({
          step: "db.transient_connection_retry",
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

function isRetrySafePoolQuery(args: unknown[]): boolean {
  const query = args[0]
  const text =
    typeof query === "string"
      ? query
      : query &&
          typeof query === "object" &&
          "text" in query &&
          typeof query.text === "string"
        ? query.text
        : ""
  return /^\s*(select|show)\b/i.test(text)
}

/**
 * Wrap `pool.query` so promise-based read queries retry on dead connections.
 * Writes are deliberately not replayed: a disconnect after the server commits
 * is ambiguous and transparent retry can duplicate mutations. Callback-style
 * `query` is also left unchanged.
 */
export function wrapPoolQueryWithTransientRetry(pool: Pool): void {
  const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown

  pool.query = ((...args: unknown[]) => {
    const maybeCallback = args.find((a) => typeof a === "function")
    if (maybeCallback || !isRetrySafePoolQuery(args)) {
      return originalQuery(...args)
    }

    return withTransientDbQueryRetry(
      () => Promise.resolve(originalQuery(...args)),
      POOL_READ_RETRY,
    )
  }) as typeof pool.query
}
