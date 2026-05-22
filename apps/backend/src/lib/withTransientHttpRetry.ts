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
  const code = (error as NodeJS.ErrnoException)?.code
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND"
  )
}

/**
 * Retries `run` on transient HTTP upstream failures (502/503/504 surfaced as
 * {@link TransientHttpError}) and common `fetch` network errors, with exponential
 * backoff and small jitter.
 */
export async function withTransientHttpRetry<T>(
  run: () => Promise<T>,
  opts?: WithTransientHttpRetryOptions,
): Promise<T> {
  const retries = opts?.retries ?? 2
  const baseDelayMs = opts?.baseDelayMs ?? 200
  const maxAttempts = retries + 1
  let last: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await run()
    } catch (e) {
      last = e
      if (isRetryableFetchFailure(e) && attempt < maxAttempts - 1) {
        const jitter = Math.floor(Math.random() * 80)
        await new Promise((r) =>
          setTimeout(r, baseDelayMs * 2 ** attempt + jitter),
        )
        continue
      }
      throw e
    }
  }

  throw last
}
