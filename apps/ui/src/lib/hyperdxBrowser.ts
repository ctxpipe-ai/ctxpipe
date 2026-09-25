import HyperDX from "@hyperdx/browser"
import {
  type HyperDxOrgRef,
  type HyperDxSessionIdentity,
  hyperdxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import { noteHyperDxSessionIdentity } from "@/lib/hyperdxQueryErrors"

const IDENTITY_STORAGE_KEY = "ctxpipe.hyperdx.identity"
const SESSION_MARKER_KEY = "ctxpipe.hd.session"

type CachedIdentity = HyperDxSessionIdentity & {
  sessionKey: string
  orgs: HyperDxOrgRef[]
}

function currentPathname(): string {
  if (typeof window === "undefined") return ""
  return window.location?.pathname ?? ""
}

function isAuthBoundaryPath(pathname: string): boolean {
  return (
    pathname === "/.auth/sign-in" ||
    pathname === "/.auth/sign-out" ||
    pathname.startsWith("/.auth/sign-in/") ||
    pathname.startsWith("/.auth/sign-out/")
  )
}

/** First segment of `/$orgSlug`, ignoring dot-routes and onboarding. */
export function orgSlugFromPathname(pathname: string): string {
  const segment =
    pathname.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean)[0] ?? ""
  if (!segment || segment.startsWith(".") || segment === "onboarding") return ""
  return segment
}

function readOrgList(value: unknown): HyperDxOrgRef[] {
  if (!Array.isArray(value)) return []
  const orgs: HyperDxOrgRef[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const id = Reflect.get(item, "id")
    const slug = Reflect.get(item, "slug")
    if (typeof id !== "string" || typeof slug !== "string" || !id || !slug) {
      continue
    }
    orgs.push({ id, slug })
  }
  return orgs
}

function readSessionMarker(): string | null {
  if (typeof localStorage === "undefined") return null
  try {
    const value = localStorage.getItem(SESSION_MARKER_KEY)
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function writeSessionMarker(value: string): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(SESSION_MARKER_KEY, value)
  } catch {
    // Private mode can reject storage writes.
  }
}

function clearSessionMarker(): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(SESSION_MARKER_KEY)
  } catch {
    // Ignore storage failures.
  }
}

function isStoredIdentity(value: {
  userId?: unknown
  teamId?: unknown
  teamName?: unknown
  sessionKey?: unknown
  orgs?: unknown
}): value is {
  userId: string
  teamId: string
  teamName: string
  sessionKey: string
  orgs?: unknown
} {
  return (
    typeof value.userId === "string" &&
    typeof value.teamId === "string" &&
    typeof value.teamName === "string" &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0
  )
}

function readIdentityCache(): CachedIdentity | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedIdentity>
    if (!isStoredIdentity(parsed)) return null
    return {
      userId: parsed.userId,
      teamId: parsed.teamId,
      teamName: parsed.teamName,
      sessionKey: parsed.sessionKey,
      orgs: readOrgList(parsed.orgs),
    }
  } catch {
    return null
  }
}

function writeIdentityCache(
  attributes: HyperDxSessionIdentity,
  organizations?: readonly HyperDxOrgRef[],
): void {
  if (typeof sessionStorage === "undefined") return
  const cached = readIdentityCache()
  const marker = readSessionMarker()
  const sameUser =
    Boolean(marker) &&
    cached !== null &&
    cached.userId === attributes.userId &&
    cached.sessionKey === marker
  const sessionKey = sameUser && marker ? marker : crypto.randomUUID()
  const orgs =
    organizations === undefined
      ? sameUser
        ? (cached?.orgs ?? [])
        : []
      : organizations.flatMap((org) =>
          org.id && org.slug ? [{ id: org.id, slug: org.slug }] : [],
        )
  const entry = {
    userId: attributes.userId,
    teamId: attributes.teamId,
    teamName: attributes.teamName,
    sessionKey,
    orgs,
  }
  // Same predicate as `readIdentityCache`. An omitted teamId must not be stored.
  if (!isStoredIdentity(entry)) return
  writeSessionMarker(sessionKey)
  try {
    sessionStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // Private mode can reject storage writes.
  }
}

function clearIdentityStorage(): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.removeItem(IDENTITY_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

function clearIdentityCache(): void {
  clearIdentityStorage()
  clearSessionMarker()
}

function loadCachedIdentity(pathname: string): CachedIdentity | null {
  if (isAuthBoundaryPath(pathname)) {
    clearIdentityCache()
    return null
  }
  const marker = readSessionMarker()
  const cached = readIdentityCache()
  if (!marker || !cached || cached.sessionKey !== marker) {
    clearIdentityStorage()
    return null
  }
  return cached
}

/** Ids cached from the last signed-in page, applied before the session request returns. */
export function readCachedHyperDxIdentity(
  pathname = currentPathname(),
): HyperDxSessionIdentity | null {
  const cached = loadCachedIdentity(pathname)
  if (!cached) return null
  return {
    userId: cached.userId,
    teamId: cached.teamId,
    teamName: cached.teamName,
  }
}

/**
 * Same cache as `readCachedHyperDxIdentity`, with `teamId` / `teamName` taken
 * from the org slug already in the URL when that slug is in the cached org list.
 * A slug we have not cached does not keep the previous org's id.
 */
export function readEarlyHyperDxIdentity(
  pathname = currentPathname(),
): HyperDxSessionIdentity | null {
  const cached = loadCachedIdentity(pathname)
  if (!cached) return null
  const slug = orgSlugFromPathname(pathname)
  if (!slug) {
    return {
      userId: cached.userId,
      teamId: cached.teamId,
      teamName: cached.teamName,
    }
  }
  const fromList = cached.orgs.find((org) => org.slug === slug)
  if (fromList) {
    return {
      userId: cached.userId,
      teamId: fromList.id,
      teamName: fromList.slug,
    }
  }
  if (cached.teamName === slug) {
    return {
      userId: cached.userId,
      teamId: cached.teamId,
      teamName: slug,
    }
  }
  return {
    userId: cached.userId,
    teamId: "",
    teamName: "",
  }
}

/**
 * Last bag passed to the SDK. Empty means the processor has no identity keys.
 * `@hyperdx/otel-web` 0.20.0 `dist/esm/SplunkSpanAttributesProcessor.js`
 * `setGlobalAttributes` (lines 20-28) `Object.assign`s a truthy argument onto
 * `_globalAttributes` and deletes every key when the argument is falsy.
 * `@hyperdx/browser` 0.26.0 forwards that call (`Rum.setGlobalAttributes`).
 * Init seeds the processor from `deploymentEnvironment`, `version`, and
 * `globalAttributes` (`dist/esm/index.js`, `new SplunkSpanAttributesProcessor`).
 * Our `HyperDX.init` passes none of those, so a clear removes only identity keys.
 */
let publishedGlobalAttributes = ""

export function applyHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
): void {
  const next = hyperdxGlobalAttributes(attributes)
  const serialized = JSON.stringify(next)
  if (
    publishedGlobalAttributes.length > 0 &&
    publishedGlobalAttributes !== serialized
  ) {
    HyperDX.setGlobalAttributes(null as unknown as Record<string, string>)
  }
  if (publishedGlobalAttributes !== serialized) {
    HyperDX.setGlobalAttributes(next)
    publishedGlobalAttributes = serialized
  }
}

/** Test isolation for the published-attribute guard. */
export function resetHyperDxPublishedAttributesForTests(): void {
  publishedGlobalAttributes = ""
}

/** No-ops until `HyperDX.init` has run (`@hyperdx/otel-web` checks `inited`). */
export function recordHyperDxAction(
  name: string,
  attributes?: Record<string, string>,
): void {
  HyperDX.addAction(name, attributes)
}

export function recordHyperDxException(
  error: unknown,
  attributes?: Record<string, string>,
): void {
  HyperDX.recordException(error, attributes)
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
  options?: {
    activeOrganizationId?: string
    organizations?: readonly HyperDxOrgRef[]
  },
): void {
  applyHyperDxGlobalAttributes(attributes)
  writeIdentityCache(attributes, options?.organizations)
  noteHyperDxSessionIdentity("signed-in", {
    teamId: attributes.teamId,
    activeOrganizationId: options?.activeOrganizationId ?? "",
  })
}

export function clearHyperDxGlobalAttributes(): void {
  // Falsy deletes every key. See `applyHyperDxGlobalAttributes`.
  HyperDX.setGlobalAttributes(null as unknown as Record<string, string>)
  publishedGlobalAttributes = ""
  clearIdentityCache()
  noteHyperDxSessionIdentity("signed-out")
}
