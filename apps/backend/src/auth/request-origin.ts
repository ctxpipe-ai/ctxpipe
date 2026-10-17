import type { Env } from "../config/env.js"

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  )
}

/**
 * True when a browser `Origin` header names this app: `AUTH_BASE_URL`, an
 * origin in `AUTH_ALLOWED_ORIGINS`, or, when `AUTH_BASE_URL` is a loopback
 * host, a loopback origin with the same scheme and port.
 */
export function isAllowedRequestOrigin(
  env: Pick<Env, "AUTH_BASE_URL" | "AUTH_ALLOWED_ORIGINS">,
  originHeader: string,
): boolean {
  try {
    const expected = new URL(env.AUTH_BASE_URL)
    const origin = new URL(originHeader)
    const configuredOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    return (
      origin.origin === expected.origin ||
      configuredOrigins.includes(origin.origin) ||
      (isLoopbackHostname(expected.hostname) &&
        isLoopbackHostname(origin.hostname) &&
        origin.protocol === expected.protocol &&
        origin.port === expected.port)
    )
  } catch {
    return false
  }
}
