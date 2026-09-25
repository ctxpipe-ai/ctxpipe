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

export type HyperDxRouteMatch = {
  routeId: string
  pathname?: string
  params?: { orgSlug?: unknown }
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }
  return pathname
}

/**
 * The router store emits the next pathname before `matches` catch up.
 * A page view is ready when the deepest match covers that pathname.
 */
export function routerLocationMatchesResolved(
  pathname: string,
  matches: readonly HyperDxRouteMatch[] | undefined,
): boolean {
  if (!matches || matches.length === 0) return false
  const leafPath = matches[matches.length - 1]?.pathname
  if (!leafPath) return false
  return normalizePath(leafPath) === normalizePath(pathname)
}

/** Org slug from the `/$orgSlug` match param. `/onboarding` and `/.auth/*` are not orgs. */
export function orgSlugFromMatches(
  matches: readonly HyperDxRouteMatch[] | undefined,
): string {
  if (!matches) return ""
  for (let index = matches.length - 1; index >= 0; index--) {
    const slug = matches[index]?.params?.orgSlug
    if (typeof slug === "string" && slug.length > 0) return slug
  }
  return ""
}

export function hyperdxPageViewFromMatches(input: {
  pathname: string
  matches: readonly HyperDxRouteMatch[] | undefined
}): HyperDxPageViewAttributes {
  return hyperdxPageViewAttributes({
    path: input.pathname,
    routeId: deepestRouteId(input.matches),
    orgSlug: orgSlugFromMatches(input.matches),
  })
}

export type HyperDxOrgRef = { id: string; slug: string }

/**
 * Prefer the org in the URL. If that slug is not in the list yet, still keep
 * the slug. Otherwise use the session's active organization.
 */
export function resolveHyperDxTeam(input: {
  orgSlugFromRoute: string
  organizations: readonly HyperDxOrgRef[] | undefined
  activeOrganizationId: string
}): { teamId: string; teamName: string } {
  const organizations = input.organizations ?? []
  if (input.orgSlugFromRoute) {
    const fromRoute = organizations.find(
      (org) => org.slug === input.orgSlugFromRoute,
    )
    if (fromRoute) return { teamId: fromRoute.id, teamName: fromRoute.slug }
    if (input.activeOrganizationId) {
      return {
        teamId: input.activeOrganizationId,
        teamName: input.orgSlugFromRoute,
      }
    }
    return { teamId: "", teamName: input.orgSlugFromRoute }
  }
  if (input.activeOrganizationId) {
    const active = organizations.find(
      (org) => org.id === input.activeOrganizationId,
    )
    if (active) return { teamId: active.id, teamName: active.slug }
    return { teamId: input.activeOrganizationId, teamName: "" }
  }
  return { teamId: "", teamName: "" }
}

export function readActiveOrganizationId(session: unknown): string {
  if (!session || typeof session !== "object") return ""
  const value = Reflect.get(session, "activeOrganizationId")
  return typeof value === "string" ? value : ""
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
