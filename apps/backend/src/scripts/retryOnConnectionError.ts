import type { ClientRequest } from "node:http"

const connectionErrorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
])

export function isConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && connectionErrorCodes.has(code)
}

/** A probe timeout is a connection error, so the retry covers it. */
export function connectionTimeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" })
}

/**
 * Runs a probe that must be refused, for example a request with a wrong DNS
 * pin. Only the error code `refusalCode` passes. A response rejects with
 * `answeredMessage`. A timeout rejects with `ETIMEDOUT`. Any other error
 * rejects as it is, so the retry covers a connection error and then fails.
 */
export function expectRefusal(
  open: (onResponse: () => void) => ClientRequest,
  {
    timeoutMs,
    timeoutMessage,
    answeredMessage,
    refusalCode,
  }: {
    timeoutMs: number
    timeoutMessage: string
    answeredMessage: string
    refusalCode: string
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = open(() => reject(new Error(answeredMessage)))
    req.setTimeout(timeoutMs, () =>
      req.destroy(connectionTimeoutError(timeoutMessage)),
    )
    req.on("error", (error: NodeJS.ErrnoException) =>
      error.code === refusalCode ? resolve() : reject(error),
    )
    req.end()
  })
}

/**
 * Runs `attempt` again after a connection error, up to `attempts` times in
 * total. Any other error stops at once, so a real failure is never hidden.
 */
export async function retryOnConnectionError<T>(
  attempt: () => Promise<T>,
  { attempts = 3, delayMs = 1_000 } = {},
): Promise<T> {
  for (let number = 1; ; number += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (number >= attempts || !isConnectionError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
