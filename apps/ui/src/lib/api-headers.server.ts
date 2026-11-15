import { getRequestHeader } from "@tanstack/react-start/server"

/**
 * Forward auth cookies and the `traceparent` from the incoming SSR request to
 * backend API calls. The backend proxy span of the page is the parent, so the
 * server-render calls join the page trace. The client address headers that
 * the backend reads (`ipAddressHeaders` in its auth config) go too, so that
 * the backend rate limits the browser of the page, not the UI server.
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
