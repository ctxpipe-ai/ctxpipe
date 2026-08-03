/** Default libpq `connect_timeout` (seconds) for Neon cold starts / TCP hangs. */
export const POSTGRES_CONNECT_TIMEOUT_SECONDS = 30

/**
 * Ensure a Postgres connection URL has `connect_timeout` set (seconds).
 * Does not override an explicit value already present in the URL.
 */
export function withPostgresConnectTimeout(
  connectionString: string,
  seconds: number = POSTGRES_CONNECT_TIMEOUT_SECONDS,
): string {
  try {
    const url = new URL(connectionString)
    if (!url.searchParams.has("connect_timeout")) {
      url.searchParams.set("connect_timeout", String(seconds))
    }
    return url.toString()
  } catch {
    // Non-URL forms (rare keyword/value DSNs) — leave unchanged.
    return connectionString
  }
}
