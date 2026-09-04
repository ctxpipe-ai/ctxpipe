import { log } from "../observability/logger.js"
import { memoryFitLogFields } from "./memoryFitError.js"

/** Thrown to trigger a retry inside {@link withTransientHttpRetry}. */
export class TransientHttpError extends Error {
  override readonly name = "TransientHttpError"
  readonly transientHttp = true as const

  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
  }
}

export type WithTransientHttpRetryOptions = {
  /** Retries after the first attempt (default 2 → 3 attempts total). */
  retries?: number
  baseDelayMs?: number
  /** Cap on exponential backoff delay (default unbounded aside from jitter). */
  maxDelayMs?: number
}

/** Advisor and interactive tool calls. Ingestion jobs keep the longer budget. */
export const CODESEARCH_QUERY_RETRY = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 1_000,
} as const

export const CODESEARCH_QUERY_TIMEOUT_MS = 25_000

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as NodeJS.ErrnoException).code
  if (typeof code === "string") return code
  if ("cause" in error) return errnoCode((error as { cause: unknown }).cause)
  return undefined
}

function isRetryableFetchFailure(error: unknown): boolean {
  if (error instanceof TransientHttpError) return true
  if (error instanceof TypeError) {
    const msg = String((error as Error).message).toLowerCase()
    if (msg.includes("fetch") || msg.includes("network")) return true
  }
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: string }).name
    if (name === "AbortError") return false
  }
  const code = errnoCode(error)
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED"
  )
}

function isTransientGatewayResponse(value: unknown): value is Response {
  return (
    typeof Response !== "undefined" &&
    value instanceof Response &&
    (value.status === 502 || value.status === 503 || value.status === 504)
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Retries `run` on transient HTTP upstream failures — {@link TransientHttpError},
 * Response status 502/503/504 when `run` returns a {@link Response}, and common
 * `fetch` network errors — with exponential backoff and small jitter. Logs info
 * on each retry; does not log errors for intermediate failures (callers may log
 * after the final throw).
 */
export async function withTransientHttpRetry<T>(
  run: () => Promise<T>,
  opts?: WithTransientHttpRetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? 2
  const baseDelayMs = opts?.baseDelayMs ?? 200
  const maxDelayMs = opts?.maxDelayMs
  const maxAttempts = retries + 1
  let last: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await run()
      if (isTransientGatewayResponse(result)) {
        await result.text().catch(() => "")
        throw new TransientHttpError(
          `transient HTTP ${result.status}`,
          result.status,
        )
      }
      return result
    } catch (e) {
      last = e
      if (isRetryableFetchFailure(e) && attempt < maxAttempts - 1) {
        const jitter = Math.floor(Math.random() * 80)
        const rawDelay = baseDelayMs * 2 ** attempt + jitter
        const delayMs =
          maxDelayMs == null ? rawDelay : Math.min(maxDelayMs, rawDelay)
        log.info({
          step: "http.transient_retry",
          attempt: attempt + 1,
          maxAttempts,
          delayMs,
          message: errorMessage(e),
          ...memoryFitLogFields(e),
        })
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      throw e
    }
  }

  throw last
}
