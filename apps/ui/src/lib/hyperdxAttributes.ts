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
 * Every key is always present. `""` means missing, so one assign replaces the previous bag.
 */
export function hyperdxGlobalAttributes(input: {
  userId?: string | null
  teamId?: string | null
  teamName?: string | null
}): HyperDxGlobalAttributes {
  const userId = input.userId ?? ""
  const teamId = input.teamId ?? ""
  const teamName = input.teamName ?? ""
  return {
    userId,
    teamId,
    teamName,
    "enduser.id": userId,
    "ctxpipe.org.id": teamId,
    "ctxpipe.org.slug": teamName,
  }
}

export type HyperDxPageViewAttributes = {
  "url.path": string
  route: string
}

/** One resolved navigation. `route` is the route template (`routeId`), not the URL. */
export function hyperdxPageViewAction(input: {
  pathname: string
  routeId: string
}): HyperDxPageViewAttributes {
  return {
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

/** Auth pages have no org context, so org ids on those spans are empty. */
export function isHyperDxAuthPath(pathname: string): boolean {
  return pathname === "/.auth" || pathname.startsWith("/.auth/")
}

export function isHyperDxSignOutPath(pathname: string): boolean {
  return (
    pathname === "/.auth/sign-out" || pathname.startsWith("/.auth/sign-out/")
  )
}

/**
 * Session, org list, and URL → the attribute identity.
 * Shared by the document SSR read and `HyperDxProvider`.
 */
export function hyperdxIdentity(
  session: {
    user?: { id?: string | null } | null
    session?: { activeOrganizationId?: string | null } | null
  } | null,
  organizations: readonly HyperDxOrgRef[] | null | undefined,
  pathname: string,
): HyperDxSessionIdentity | null {
  if (isHyperDxSignOutPath(pathname)) return null
  const userId = session?.user?.id ?? ""
  if (!userId) return null
  if (isHyperDxAuthPath(pathname)) {
    return { userId, teamId: "", teamName: "" }
  }
  const active = session?.session?.activeOrganizationId
  const team = resolveHyperDxTeam({
    orgSlugFromRoute: orgSlugFromPathname(pathname),
    organizations: organizations ?? [],
    activeOrganizationId: typeof active === "string" ? active : "",
  })
  return { userId, teamId: team.teamId, teamName: team.teamName }
}

/**
 * Identity to publish once `useSession` has settled.
 * `useAuthQuery` starts at `data: null`, so a null org list is "not loaded",
 * same as `undefined`. While it is null, return the document identity so the
 * SSR team id stays up. `undefined` means leave the current attributes alone.
 * `null` means clear them.
 */
export function hyperdxIdentityAfterSession(input: {
  session: Parameters<typeof hyperdxIdentity>[0]
  organizations: readonly HyperDxOrgRef[] | null | undefined
  pathname: string
  documentIdentity: HyperDxSessionIdentity | null
}): HyperDxSessionIdentity | null | undefined {
  if (
    input.session?.user?.id &&
    input.organizations == null &&
    !isHyperDxAuthPath(input.pathname)
  ) {
    const slug = orgSlugFromPathname(input.pathname)
    if (!slug || slug === (input.documentIdentity?.teamName ?? "")) {
      return input.documentIdentity ?? undefined
    }
  }
  return hyperdxIdentity(
    input.session,
    input.organizations ?? [],
    input.pathname,
  )
}
