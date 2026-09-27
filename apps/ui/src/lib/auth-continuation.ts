export type AuthContinuationProps = {
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

export function getOAuthOrganizationChangeHref(search: string): string {
  const normalizedSearch = search.startsWith("?")
    ? search
    : search.length > 0
      ? `?${search}`
      : ""
  return `/.auth/select-organization${normalizedSearch}`
}

export function getAuthContinuationProps(
  _pathname: string,
  search: string,
): AuthContinuationProps {
  const normalizedSearch = search.startsWith("?") ? search : `?${search}`
  const searchParams = new URLSearchParams(
    normalizedSearch === "?" ? "" : normalizedSearch.slice(1),
  )

  const redirectTo = searchParams.get("redirectTo") ?? undefined

  return { redirectTo }
}
