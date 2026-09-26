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

export type HyperDxPageViewAttributes = {
  path: string
  "url.path": string
  route: string
}

/** One resolved navigation. `route` is the route template (`routeId`), not the URL. */
export function hyperdxPageViewAction(input: {
  pathname: string
  routeId: string
}): HyperDxPageViewAttributes {
  return {
    path: input.pathname,
    "url.path": input.pathname,
    route: input.routeId,
  }
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

/** First segment of `/$orgSlug`, ignoring dot-routes and onboarding. */
export function orgSlugFromPathname(pathname: string): string {
  const segment =
    pathname.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean)[0] ?? ""
  if (!segment || segment.startsWith(".") || segment === "onboarding") return ""
  return segment
}

/** Auth pages have no org context, so spans there omit org keys. */
export function isHyperDxAuthPath(pathname: string): boolean {
  return pathname === "/.auth" || pathname.startsWith("/.auth/")
}

export function isHyperDxSignOutPath(pathname: string): boolean {
  return (
    pathname === "/.auth/sign-out" || pathname.startsWith("/.auth/sign-out/")
  )
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
