import { ApiError, apiFetch } from "./api-result"
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

async function authFetchInit(): Promise<RequestInit> {
  // `import.meta.env.SSR` lets Vite drop the .server import from the client bundle.
  if (import.meta.env.SSR) {
    const { getServerApiHeaders } = await import("./api-headers.server")
    return {
      credentials: "include",
      headers: getServerApiHeaders(),
    }
  }
  return { credentials: "include" }
}

/**
 * Session for route loaders — works on SSR with forwarded cookies.
 * Returns null only when the backend says there is no session. A network
 * error, a timeout, or a server error throws `ApiError`: the loader must not
 * send a signed-in user to sign-in because one call failed.
 */
export async function fetchSsrSession(): Promise<SsrSession> {
  const init = await authFetchInit()
  const res = await apiFetch(
    `${authBaseUrl()}/.auth/api/v1/auth/get-session`,
    init,
  )
  if (res.status === 401) return null
  if (!res.ok) throw failedAuthCall(res, "Session check failed")
  const data = (await res.json()) as SsrSession | null
  if (!data?.session || !data.user) return null
  return data
}

/**
 * Org membership list for route loaders. Returns [] only for a signed-out
 * request (401). Other failures throw `ApiError`, so that a failed call does
 * not send the user to onboarding.
 */
export async function fetchSsrOrganizations(): Promise<SsrOrganization[]> {
  const init = await authFetchInit()
  const res = await apiFetch(
    `${authBaseUrl()}/.auth/api/v1/auth/organization/list`,
    init,
  )
  if (res.status === 401) return []
  if (!res.ok) throw failedAuthCall(res, "Organization list failed")
  const data = (await res.json()) as SsrOrganization[] | null
  return Array.isArray(data) ? data : []
}

function failedAuthCall(res: Response, message: string): ApiError {
  return new ApiError(`${message} (${res.status})`, res.status)
}
