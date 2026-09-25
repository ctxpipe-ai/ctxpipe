/** Browser HyperDX attribute mapping. Ids and slugs only — no email or name. */

export type HyperDxGlobalAttributes = {
  userId: string
  teamId: string
  teamName: string
}

export function hyperdxGlobalAttributes(input: {
  userId?: string | null
  teamId?: string | null
  teamName?: string | null
}): HyperDxGlobalAttributes {
  return {
    userId: input.userId ?? "",
    teamId: input.teamId ?? "",
    teamName: input.teamName ?? "",
  }
}

export function clearedHyperDxGlobalAttributes(): HyperDxGlobalAttributes {
  return hyperdxGlobalAttributes({})
}

export type HyperDxPageViewAttributes = {
  path: string
  route: string
  "ctxpipe.org.slug": string
}

export function hyperdxPageViewAttributes(input: {
  path: string
  routeId?: string | null
  orgSlug?: string | null
}): HyperDxPageViewAttributes {
  return {
    path: input.path,
    route: input.routeId ?? "",
    "ctxpipe.org.slug": input.orgSlug ?? "",
  }
}

export function deepestRouteId(
  matches: readonly { routeId: string }[] | undefined,
): string {
  if (!matches || matches.length === 0) return ""
  return matches[matches.length - 1]?.routeId ?? ""
}

/** First path segment when it is an org slug. Dot-routes (`/.auth`, `/.otel`) are not orgs. */
export function orgSlugFromPathname(pathname: string): string {
  const firstSegment = pathname.split("/").filter(Boolean)[0]
  if (!firstSegment || firstSegment.startsWith(".")) return ""
  return firstSegment
}

const HYPERDX_SIGN_IN_PATHS = new Set([
  "/.auth/sign-in",
  "/.auth/two-factor",
  "/.auth/callback",
])

/** Paths where a session change is a completed sign-in (password, 2FA, or OAuth callback). */
export function isHyperDxSignInPath(pathname: string): boolean {
  return HYPERDX_SIGN_IN_PATHS.has(pathname)
}

/**
 * `@hyperdx/browser` does not exclude its exporter URL.
 * Strings in `ignoreUrls` are exact matches; this regex covers `/.otel` and `/.otel/...`.
 */
export const hyperdxExporterIgnoreUrls: RegExp[] = [/\/\.otel(?:\/|$)/]
