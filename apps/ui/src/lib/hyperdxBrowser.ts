import HyperDX from "@hyperdx/browser"
import {
  clearedHyperDxGlobalAttributes,
  type HyperDxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import { noteHyperDxSessionIdentity } from "@/lib/hyperdxQueryErrors"

const IDENTITY_STORAGE_KEY = "ctxpipe.hyperdx.identity"
const SESSION_MARKER_KEY = "ctxpipe.hd.session"

type CachedIdentity = HyperDxGlobalAttributes & { sessionKey: string }

function currentPathname(): string {
  if (typeof window === "undefined") return ""
  return window.location?.pathname ?? ""
}

function isAuthBoundaryPath(): boolean {
  const pathname = currentPathname()
  return (
    pathname === "/.auth/sign-in" ||
    pathname === "/.auth/sign-out" ||
    pathname.startsWith("/.auth/sign-in/") ||
    pathname.startsWith("/.auth/sign-out/")
  )
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

function readIdentityCache(): CachedIdentity | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedIdentity>
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.teamId !== "string" ||
      typeof parsed.teamName !== "string" ||
      typeof parsed.sessionKey !== "string" ||
      parsed.sessionKey.length === 0
    ) {
      return null
    }
    return {
      userId: parsed.userId,
      teamId: parsed.teamId,
      teamName: parsed.teamName,
      sessionKey: parsed.sessionKey,
    }
  } catch {
    return null
  }
}

function writeIdentityCache(attributes: HyperDxGlobalAttributes): void {
  if (typeof sessionStorage === "undefined") return
  const cached = readIdentityCache()
  const marker = readSessionMarker()
  const sessionKey =
    marker &&
    cached &&
    cached.userId === attributes.userId &&
    cached.sessionKey === marker
      ? marker
      : crypto.randomUUID()
  writeSessionMarker(sessionKey)
  try {
    sessionStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        userId: attributes.userId,
        teamId: attributes.teamId,
        teamName: attributes.teamName,
        sessionKey,
      }),
    )
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

/** Ids cached from the last signed-in page, applied before the session request returns. */
export function readCachedHyperDxIdentity(): HyperDxGlobalAttributes | null {
  if (isAuthBoundaryPath()) {
    clearIdentityCache()
    return null
  }
  const marker = readSessionMarker()
  const cached = readIdentityCache()
  if (!marker || !cached || cached.sessionKey !== marker) {
    clearIdentityStorage()
    return null
  }
  return {
    userId: cached.userId,
    teamId: cached.teamId,
    teamName: cached.teamName,
  }
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
  attributes: HyperDxGlobalAttributes,
  options?: { activeOrganizationId?: string },
): void {
  HyperDX.setGlobalAttributes(attributes)
  writeIdentityCache(attributes)
  noteHyperDxSessionIdentity("signed-in", {
    teamId: attributes.teamId,
    activeOrganizationId: options?.activeOrganizationId ?? "",
  })
}

export function clearHyperDxGlobalAttributes(): void {
  HyperDX.setGlobalAttributes(clearedHyperDxGlobalAttributes())
  clearIdentityCache()
  noteHyperDxSessionIdentity("signed-out")
}
