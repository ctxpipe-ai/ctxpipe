import { safeAuthRedirectPath } from "./safe-auth-redirect"

type AuthContinuationProps = {
  redirectTo?: string
}

export function getOAuthRedirectUri(data: unknown): string | undefined {
  if (typeof data === "string") return data
  if (!data || typeof data !== "object") return undefined

  for (const key of ["redirect_uri", "redirectUri", "uri", "url"]) {
    const value = Reflect.get(data, key)
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** The `redirectTo` of the query, only when it stays on `origin`. */
export function getAuthContinuationProps(
  origin: string,
  search: string,
): AuthContinuationProps {
  const normalizedSearch = search.startsWith("?") ? search : `?${search}`
  const searchParams = new URLSearchParams(
    normalizedSearch === "?" ? "" : normalizedSearch.slice(1),
  )

  const redirectTo =
    safeAuthRedirectPath(searchParams.get("redirectTo"), "", origin) ||
    undefined

  return { redirectTo }
}
