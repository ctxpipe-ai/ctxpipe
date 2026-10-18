/**
 * A path on `origin` only: a relative path, or an absolute URL on `origin`.
 * The browser URL parser decides, so a protocol-relative, backslash, or
 * script URL gives `fallback`.
 */
export function safeAuthRedirectPath(
  value: string | null | undefined,
  fallback: string,
  origin: string,
): string {
  if (!value) return fallback
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
