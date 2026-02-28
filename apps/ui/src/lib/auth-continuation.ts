export type AuthContinuationProps = {
  redirectTo?: string
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
