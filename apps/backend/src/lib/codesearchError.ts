export type CodesearchError = {
  status: number
  message: string
  code?: string
}

/**
 * Reads a codesearch error body (`{ error, code? }` or plain text).
 * A successful response is returned without consuming the body.
 */
export async function readCodesearchError(
  res: Response,
): Promise<CodesearchError> {
  if (res.ok) return { status: res.status, message: "" }
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
  return code
    ? { status: res.status, message, code }
    : { status: res.status, message }
}
