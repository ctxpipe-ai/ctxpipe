/** Drizzle's `Failed query:` error puts bound values on a `params:` line. */
export function scrubDrizzleParams(text: string): string {
  return text.replace(/\r?\nparams:[^\r\n]*/gi, "")
}

function plainDbCause(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object" || depth > 5) return undefined
  const record = value as Record<string, unknown>
  const name = typeof record.name === "string" ? record.name : "Error"
  const message =
    typeof record.message === "string"
      ? scrubDrizzleParams(record.message)
      : undefined
  const code = typeof record.code === "string" ? record.code : undefined
  const cause =
    "cause" in record ? plainDbCause(record.cause, depth + 1) : undefined
  return {
    name,
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(cause !== undefined ? { cause } : {}),
  }
}

/**
 * Drizzle wraps the pg error on `error.cause`. evlog patterns skip
 * non-enumerable `message` / `stack`, so copy `{ name, message, code }`
 * and drop `detail`, `where`, `hint`, `parameters`, and `internalQuery`.
 */
export function flattenDbErrorCause(event: Record<string, unknown>): void {
  const error = event.error
  if (!error || typeof error !== "object") return
  const record = error as Record<string, unknown>
  if (typeof record.message === "string") {
    record.message = scrubDrizzleParams(record.message)
  }
  if (typeof record.stack === "string") {
    record.stack = scrubDrizzleParams(record.stack)
  }
  if ("cause" in record) record.cause = plainDbCause(record.cause, 0)
}

/** Exception for a failed query span. No bound values, detail, or cause chain. */
export function dbErrorException(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  const message = scrubDrizzleParams(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
  const sanitized = new Error(message || "database query failed")
  sanitized.name = error instanceof Error && error.name ? error.name : "error"
  if (error instanceof Error && typeof error.stack === "string") {
    const stack = scrubDrizzleParams(error.stack)
    if (!/params:/i.test(stack)) sanitized.stack = stack
  }
  return sanitized
}
