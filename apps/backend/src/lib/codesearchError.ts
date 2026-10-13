export type CodesearchError = {
  status: number
  message: string
  code?: string
}

/**
 * Reads a codesearch error body (`{ error, code? }` or plain text).
 */
export async function readCodesearchError(
  res: Response,
): Promise<CodesearchError> {
  const bodyText = await res.text().catch(() => "")
  let message = bodyText.trim()
  let code: string | undefined
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: unknown
        code?: unknown
      }
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        message = parsed.error.trim()
      }
      if (typeof parsed.code === "string" && parsed.code.length > 0) {
        code = parsed.code
      }
    } catch {
      // plain text
    }
  }
  return { status: res.status, message, code }
}

/** A codesearch answer that is not 2xx, with its status for the caller to map. */
export class CodesearchHttpError extends Error {
  override readonly name = "CodesearchHttpError"

  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message)
  }
}

/** Transport options for one codesearch request: a deadline and a retry budget. */
export type CodesearchHttpOptions = {
  signal?: AbortSignal
  retry?: { retries: number; baseDelayMs: number; maxDelayMs: number }
}
