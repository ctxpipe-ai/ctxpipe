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
