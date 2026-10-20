import { getRequestHeader } from "@tanstack/react-start/server"

/**
 * Forward auth cookies and the `traceparent` from the incoming SSR request to
 * backend API calls. The backend proxy span of the page is the parent, so the
 * server-render calls join the page trace.
 */
export function getServerApiHeaders(): HeadersInit {
  try {
    const headers: Record<string, string> = {}
    const cookie = getRequestHeader("cookie")
    if (cookie) headers.cookie = cookie
    const authorization = getRequestHeader("authorization")
    if (authorization) headers.authorization = authorization
    const traceparent = getRequestHeader("traceparent")
    if (traceparent) headers.traceparent = traceparent
    return headers
  } catch {
    // Vitest / non-request contexts have no Start AsyncLocalStorage event.
    return {}
  }
}
