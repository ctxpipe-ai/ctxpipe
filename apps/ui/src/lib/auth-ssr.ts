import { apiFetch, readApiJson } from "./api-result"
import { ssrApiBaseUrl } from "./ssr-api-base"

export type SsrAuthUser = {
  id: string
  email?: string | null
  name?: string | null
  onboardingCompletedAt?: string | null
}

export type SsrSession = {
  session: { id: string; userId: string }
  user: SsrAuthUser
} | null

export type SsrOrganization = {
  id: string
  name: string
  slug: string
}

function authBaseUrl(): string {
  if (!import.meta.env.SSR) return window.location.origin
  return ssrApiBaseUrl()
}

/**
 * The fetch options for an auth call, or null when the server-render request
 * carries no session credential. Such a request has no session, so the caller
 * answers it without a backend call. A scanner burst then cannot hit the
 * backend rate limit and turn each page into a server-render error.
 */
async function authFetchInit(): Promise<RequestInit | null> {
  // `import.meta.env.SSR` lets Vite drop the .server import from the client bundle.
  if (import.meta.env.SSR) {
    const { getServerApiHeaders, hasSessionCredential } =
      await import("./api-headers.server")
    const headers = getServerApiHeaders()
    if (!hasSessionCredential(headers)) return null
    return { credentials: "include", headers }
  }
  return { credentials: "include" }
}

/**
 * Session for route loaders — works on SSR with forwarded cookies.
 * Returns null when the request carries no session credential, or when the
 * backend says there is no session. A network error, a timeout, or a server
 * error throws `ApiError`: the loader must not send a signed-in user to
 * sign-in because one call failed.
 */
export async function fetchSsrSession(): Promise<SsrSession> {
  const init = await authFetchInit()
  if (!init) return null
  const res = await apiFetch(
    `${authBaseUrl()}/.auth/api/v1/auth/get-session`,
    init,
  )
  // TODO: Better Auth routes are outside the Hono client, so the body is unknown.
  const data = (await readApiJson(res, {
    emptyOn: [401],
    empty: null,
    message: "Session check failed",
  })) as SsrSession | null
  if (!data?.session || !data.user) return null
  return data
}

/**
 * Org membership list for route loaders. Returns [] only for a signed-out
 * request (no session credential, or 401). Other failures throw `ApiError`,
 * so that a failed call does not send the user to onboarding.
 */
export async function fetchSsrOrganizations(): Promise<SsrOrganization[]> {
  const init = await authFetchInit()
  if (!init) return []
  const res = await apiFetch(
    `${authBaseUrl()}/.auth/api/v1/auth/organization/list`,
    init,
  )
  // TODO: Better Auth routes are outside the Hono client, so the body is unknown.
  const data = (await readApiJson(res, {
    emptyOn: [401],
    empty: [],
    message: "Organization list failed",
  })) as SsrOrganization[] | null
  return Array.isArray(data) ? data : []
}
