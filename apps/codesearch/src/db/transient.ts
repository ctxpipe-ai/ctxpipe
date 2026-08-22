import type { Pool } from "pg"
import { log } from "../observability/logger.js"

const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
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
    }
  }
  return out
}

/** True for dead/reset Postgres connections suitable for a reconnect retry. */
export function isTransientDbConnectionError(error: unknown): boolean {
  for (const err of collectErrors(error)) {
    const code = errorCode(err)
    if (code && TRANSIENT_CONNECTION_CODES.has(code)) return true
    if (TRANSIENT_CONNECTION_MESSAGE_RE.test(errorMessage(err))) return true
  }
  return false
}

/**
 * Idle clients emit `error` when Postgres closes them. Without a listener,
 * Node treats that as uncaught and can exit the codesearch process mid-index.
 */
export function attachPoolErrorListener(pool: {
  on: (event: "error", listener: (err: Error) => void) => unknown
}): void {
  pool.on("error", (err) => {
    log.error({
      step: "db.pool",
      message: "Unexpected pg pool error",
      error: err instanceof Error ? err.message : String(err),
      code:
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined,
    })
  })
}

async function withTransientDbQueryRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isTransientDbConnectionError(error)) throw error
    log.info({
      step: "db.transient_connection_retry",
      message: errorMessage(error),
    })
    await new Promise((r) => setTimeout(r, 100))
    return await run()
  }
}

/** Wrap `pool.query` so promise-based queries retry once on dead connections. */
export function wrapPoolQueryWithTransientRetry(pool: Pool): void {
  const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown

  pool.query = ((...args: unknown[]) => {
    const maybeCallback = args.find((a) => typeof a === "function")
    if (maybeCallback) {
      return originalQuery(...args)
    }
    return withTransientDbQueryRetry(() =>
      Promise.resolve(originalQuery(...args)),
    )
  }) as typeof pool.query
}
