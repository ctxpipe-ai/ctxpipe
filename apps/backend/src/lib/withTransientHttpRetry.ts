import { setTimeout as delay } from "node:timers/promises"

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

type WithTransientHttpRetryOptions = {
  /** Cancel each retry delay and prevent another attempt. */
  signal?: AbortSignal
  /** Retries after the first attempt (default 2 → 3 attempts total). */
  retries?: number
  baseDelayMs?: number
  /** Cap on exponential backoff delay (default unbounded aside from jitter). */
  maxDelayMs?: number
  /**
   * Retry a restart of the upstream (connection refused, name not found) until
   * `signal` aborts, beyond `retries`: a short budget then rides over a
   * redeploy, while every other failure keeps the short budget. Needs `signal`.
   */
  retryRestartsUntilAborted?: boolean
}

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

/** The upstream is restarting: nothing listens yet, or its name is gone. */
function isRestart(error: unknown): boolean {
  const code = errnoCode(error)
  return code === "ECONNREFUSED" || code === "ENOTFOUND"
}

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

async function isOpaqueInternalServerError(value: Response): Promise<boolean> {
  if (value.status !== 500) return false
  const text = await value.clone().text()
  return /^internal server error$/i.test(text.trim())
}

async function shouldRetryGatewayResponse(value: unknown): Promise<boolean> {
  if (typeof Response === "undefined" || !(value instanceof Response)) {
    return false
  }
  if (isGatewayStatus(value.status)) return true
  return isOpaqueInternalServerError(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Retries `run` on transient HTTP upstream failures — {@link TransientHttpError},
 * Response status 502/503/504 (and opaque 500 "Internal Server Error") when `run`
 * returns a {@link Response}, and common `fetch` network errors — with exponential
 * backoff and small jitter. Logs info on each retry; does not log errors for
 * intermediate failures (callers may log after the final throw).
 */
export async function withTransientHttpRetry<T>(
  run: () => Promise<T>,
  opts?: WithTransientHttpRetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? 2
  const baseDelayMs = opts?.baseDelayMs ?? 200
  const maxDelayMs = opts?.maxDelayMs
  const maxAttempts = retries + 1

  // A restart retry (retryRestartsUntilAborted) may go past maxAttempts: the
  // signal ends it.
  for (let attempt = 0; ; attempt += 1) {
    try {
      opts?.signal?.throwIfAborted()
      const result = await run()
      if (
        result instanceof Response &&
        (await shouldRetryGatewayResponse(result))
      ) {
        await result.text().catch(() => "")
        throw new TransientHttpError(
          `transient HTTP ${result.status}`,
          result.status,
        )
      }
      return result
    } catch (e) {
      const restart =
        opts?.retryRestartsUntilAborted === true &&
        opts.signal !== undefined &&
        isRestart(e)
      if (
        isRetryableFetchFailure(e) &&
        (attempt < maxAttempts - 1 || restart)
      ) {
        const jitter = Math.floor(Math.random() * 80)
        const rawDelay = baseDelayMs * 2 ** Math.min(attempt, 30) + jitter
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
        await delay(delayMs, undefined, { signal: opts?.signal })
        continue
      }
      throw e
    }
  }
}
