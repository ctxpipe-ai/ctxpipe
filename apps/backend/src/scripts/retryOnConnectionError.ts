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
 * pin. Only a refusal passes. A timeout rejects with `ETIMEDOUT`, so the retry
 * covers it and the check fails after the last attempt.
 */
export function expectRefusal(
  open: (onResponse: () => void) => ClientRequest,
  { timeoutMs, message }: { timeoutMs: number; message: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = open(() =>
      reject(new Error("Bun ignored the callback-selected pinned address")),
    )
    req.setTimeout(timeoutMs, () =>
      req.destroy(connectionTimeoutError(message)),
    )
    req.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ETIMEDOUT" ? reject(error) : resolve(),
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
