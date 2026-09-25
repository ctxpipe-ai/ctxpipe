/** Browser HyperDX attribute mapping. Ids and slugs only — no email or name. */

export type HyperDxSessionIdentity = {
  userId: string
  teamId: string
  teamName: string
}

export type HyperDxGlobalAttributes = HyperDxSessionIdentity & {
  "enduser.id": string
  "ctxpipe.org.id": string
  "ctxpipe.org.slug": string
}

/**
 * `userId` / `teamId` / `teamName` are what HyperDX session search reads.
 * The dotted keys match backend spans so one filter works on browser and API.
 * Missing ids are omitted so an empty string is not exported.
 * `@hyperdx/otel-web` merges the bag, so callers clear before publishing a
 * smaller or different set. Sign-out wipes the bag.
 */
export function hyperdxGlobalAttributes(input: {
  userId?: string | null
  teamId?: string | null
  teamName?: string | null
}): Partial<HyperDxGlobalAttributes> {
  const userId = input.userId ?? ""
  const teamId = input.teamId ?? ""
  const teamName = input.teamName ?? ""
  const attributes: Partial<HyperDxGlobalAttributes> = {}
  if (userId) {
    attributes.userId = userId
    attributes["enduser.id"] = userId
  }
  if (teamId) {
    attributes.teamId = teamId
    attributes["ctxpipe.org.id"] = teamId
  }
  if (teamName) {
    attributes.teamName = teamName
    attributes["ctxpipe.org.slug"] = teamName
  }
  return attributes
}

export function clearedHyperDxGlobalAttributes(): Partial<HyperDxGlobalAttributes> {
  return {}
}

export type HyperDxPageViewAttributes = {
  path: string
  "url.path": string
  route: string
  "ctxpipe.org.slug"?: string
}

export function hyperdxPageViewAttributes(input: {
  path: string
  routeId?: string | null
  orgSlug?: string | null
}): HyperDxPageViewAttributes {
  const slug = input.orgSlug ?? ""
  return {
    path: input.path,
    "url.path": input.path,
    route: input.routeId ?? "",
    ...(slug ? { "ctxpipe.org.slug": slug } : {}),
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
 * Id and slug come from the same org record (the list, or nothing).
 * A route slug that is not in the list is emitted alone — never next to
 * another org's id. Off an org route, the active organization is that
 * record when the list contains it, or an id with no slug before the list loads.
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

/** Auth pages have no org context, so spans there omit org keys. */
export function isHyperDxAuthPath(pathname: string): boolean {
  return pathname === "/.auth" || pathname.startsWith("/.auth/")
}

/** Paths where a session change is a completed sign-in (password, 2FA, or OAuth callback). */
export function isHyperDxSignInPath(pathname: string): boolean {
  return HYPERDX_SIGN_IN_PATHS.has(pathname)
}

/**
 * `@hyperdx/browser` does not exclude its exporter URL.
 * Strings in `ignoreUrls` are exact matches; this regex covers `/.otel` and `/.otel/...`.
 */
export const hyperdxExporterIgnoreUrls: RegExp[] = [/\/\.otel(?:\/|$)/]
