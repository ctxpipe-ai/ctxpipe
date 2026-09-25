import HyperDX from "@hyperdx/browser"
import {
  clearedHyperDxGlobalAttributes,
  type HyperDxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import { noteHyperDxSessionIdentity } from "@/lib/hyperdxQueryErrors"

const IDENTITY_STORAGE_KEY = "ctxpipe.hyperdx.identity"

function readIdentityCache(): HyperDxGlobalAttributes | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HyperDxGlobalAttributes>
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.teamId !== "string" ||
      typeof parsed.teamName !== "string"
    ) {
      return null
    }
    return {
      userId: parsed.userId,
      teamId: parsed.teamId,
      teamName: parsed.teamName,
    }
  } catch {
    return null
  }
}

function writeIdentityCache(attributes: HyperDxGlobalAttributes): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        userId: attributes.userId,
        teamId: attributes.teamId,
        teamName: attributes.teamName,
      }),
    )
  } catch {
    // Private mode can reject storage writes.
  }
}

function clearIdentityCache(): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.removeItem(IDENTITY_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

/** Ids cached from the last signed-in page, applied before the session request returns. */
export function readCachedHyperDxIdentity(): HyperDxGlobalAttributes | null {
  return readIdentityCache()
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
