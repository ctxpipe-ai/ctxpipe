import { getRequestHeader } from "@tanstack/react-start/server"
import { getSessionCookie } from "better-auth/cookies"

/**
 * Forward auth cookies and the `traceparent` from the incoming SSR request to
 * backend API calls. The backend proxy span of the page is the parent, so the
 * server-render calls join the page trace. The client address headers that
 * the backend reads (`ipAddressHeaders` in its auth config) go too. When the
 * UI calls the backend on its private address (the hosted stack), the
 * backend then rate limits the browser of the page, not the UI server. A
 * load balancer between them appends the address of the UI.
 */
export function getServerApiHeaders(): HeadersInit {
  try {
    const headers: Record<string, string> = {}
    for (const name of [
      "cookie",
      "authorization",
      "traceparent",
      "x-forwarded-for",
      "x-real-ip",
    ]) {
      const value = getRequestHeader(name)
      if (value) headers[name] = value
    }
    return headers
  } catch {
    // Vitest / non-request contexts have no Start AsyncLocalStorage event.
    return {}
  }
}

/**
 * True when the forwarded headers can carry a session: a Better Auth session
 * cookie, or a bearer token (the backend's `bearer()` plugin).
 */
export function hasSessionCredential(headers: HeadersInit): boolean {
  const forwarded = new Headers(headers)
  return forwarded.has("authorization") || getSessionCookie(forwarded) !== null
}
