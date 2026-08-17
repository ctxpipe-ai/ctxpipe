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
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "")
  }
  return "http://localhost:3000"
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

/** Session for route loaders — works on SSR with forwarded cookies. */
export async function fetchSsrSession(): Promise<SsrSession> {
  const init = await authFetchInit()
  const res = await fetch(
    `${authBaseUrl()}/.auth/api/v1/auth/get-session`,
    init,
  )
  if (!res.ok) return null
  const data = (await res.json()) as SsrSession | null
  if (!data?.session || !data.user) return null
  return data
}

/** Org membership list for route loaders. */
export async function fetchSsrOrganizations(): Promise<SsrOrganization[]> {
  const init = await authFetchInit()
  const res = await fetch(
    `${authBaseUrl()}/.auth/api/v1/auth/organization/list`,
    init,
  )
  if (!res.ok) return []
  const data = (await res.json()) as SsrOrganization[] | null
  return Array.isArray(data) ? data : []
}
