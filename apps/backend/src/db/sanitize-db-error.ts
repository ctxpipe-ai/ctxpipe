import { DrizzleQueryError } from "drizzle-orm"

/** SQL fragments that indicate bound params may contain secrets (session tokens, etc.). */
const SENSITIVE_QUERY_MARKERS = [
  /"sessions"\."token"/i,
  /"token"\s*=\s*\$/,
  /refresh_token/i,
  /"password"/i,
  /client_secret/i,
] as const

function queryMayContainSecrets(query: string): boolean {
  return SENSITIVE_QUERY_MARKERS.some((pattern) => pattern.test(query))
}

/** Redact string query parameters for safe logging (presence + length only). */
export function redactQueryParams(
  params: unknown,
  query?: string,
): unknown {
  const redactAll =
    typeof query === "string" && queryMayContainSecrets(query)

  if (!Array.isArray(params)) {
    return redactAll ? "[redacted]" : params
  }

  return params.map((value) => {
    if (typeof value !== "string" || value.length === 0) return value
    if (!redactAll) return value
    return `<redacted len=${value.length}>`
  })
}

function isDrizzleQueryError(err: unknown): err is DrizzleQueryError {
  return err instanceof DrizzleQueryError
}

/**
 * Returns an error safe to pass to evlog / OTLP: Drizzle query failures no longer
 * embed raw session tokens in `message` when the SQL touches sensitive columns.
 */
export function sanitizeDbError(err: unknown): unknown {
  if (!isDrizzleQueryError(err)) return err

  const redactedParams = redactQueryParams(err.params, err.query)
  const sanitized = new Error(
    `Failed query: ${err.query}\nparams: ${JSON.stringify(redactedParams)}`,
  )
  sanitized.name = err.name
  if (err.cause !== undefined) {
    ;(sanitized as Error & { cause?: unknown }).cause = sanitizeDbError(
      err.cause,
    )
  }
  return sanitized
}
