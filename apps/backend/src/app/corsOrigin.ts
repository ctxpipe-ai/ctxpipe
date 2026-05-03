import type { Context } from "hono"

/**
 * True for typical local dev origins (any port), so tools like MCP Inspector
 * (browser on e.g. http://localhost:6274) work when AUTH_ALLOWED_ORIGINS lists
 * only the app and UI (portless) origins.
 */
export function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    if (u.protocol !== "http:" && u.protocol !== "https:") return false
    const host = u.hostname.toLowerCase()
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    )
  } catch {
    return false
  }
}

/**
 * Hono `cors({ origin })` value: explicit list, or "*" when unset, or a
 * resolver that also allows loopback origins for dev tooling.
 */
export function corsOriginOption(
  allowedOrigins: string[],
): string | ((origin: string, c: Context) => string | null | undefined) {
  if (allowedOrigins.length === 0) return "*"
  return (origin: string, _c: Context) => {
    if (!origin) return null
    if (allowedOrigins.includes(origin)) return origin
    if (isLoopbackBrowserOrigin(origin)) return origin
    return null
  }
}
