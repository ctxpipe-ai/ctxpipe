import { getRequestHeader } from "@tanstack/react-start/server"

/** Forward auth cookies from the incoming SSR request to backend API calls. */
export function getServerApiHeaders(): HeadersInit {
  try {
    const headers: Record<string, string> = {}
    const cookie = getRequestHeader("cookie")
    if (cookie) headers.cookie = cookie
    const authorization = getRequestHeader("authorization")
    if (authorization) headers.authorization = authorization
    return headers
  } catch {
    // Vitest / non-request contexts have no Start AsyncLocalStorage event.
    return {}
  }
}
