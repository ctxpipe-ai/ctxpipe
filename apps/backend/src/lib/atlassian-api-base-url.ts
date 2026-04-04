import type { JWTPayload } from "jose"

const ATLASSIAN_PRODUCT_API_HOST = "api.atlassian.com"

/**
 * FIT embeds `app.apiBaseUrl` per
 * https://developer.atlassian.com/platform/forge/remote/calling-product-apis/
 *
 * Returns a normalized base URL (no trailing slash) or undefined if missing/invalid.
 */
export function parseAtlassianApiBaseUrlFromFitPayload(
  payload: JWTPayload,
): string | undefined {
  const app = payload.app
  if (!app || typeof app !== "object" || Array.isArray(app)) return undefined
  const raw = (app as Record<string, unknown>).apiBaseUrl
  if (typeof raw !== "string" || raw.length === 0) return undefined
  return validateAtlassianProductApiBaseUrl(raw)
}

/** HTTPS-only, host must be api.atlassian.com; rejects userinfo and invalid URLs. */
export function validateAtlassianProductApiBaseUrl(
  raw: string,
): string | undefined {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== "https:") return undefined
  if (u.hostname !== ATLASSIAN_PRODUCT_API_HOST) return undefined
  if (u.username || u.password) return undefined
  const path = u.pathname.replace(/\/+$/, "")
  if (path.length === 0) return undefined
  return `${u.origin}${path}`
}

/** Prefer FIT-derived base URL from DB; otherwise template + cloudId. */
export function resolveAtlassianConfluenceApiBaseUrl(installation: {
  cloudId: string
  atlassianApiBaseUrl: string | null
}): string {
  const stored = installation.atlassianApiBaseUrl?.trim()
  if (stored) {
    return stored.replace(/\/+$/, "")
  }
  return `https://api.atlassian.com/ex/confluence/${installation.cloudId}`
}
