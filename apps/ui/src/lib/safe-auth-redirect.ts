/**
 * A path on `origin` only: a relative path, or an absolute URL on `origin`.
 * The browser URL parser decides, so a protocol-relative, backslash, or
 * script URL gives `fallback`. The result is also safe as a relative URL:
 * a normalized path that starts with two slashes (or a slash and a
 * backslash) would leave the origin, so it gives `fallback` too.
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
    const path = `${url.pathname}${url.search}${url.hash}`
    if (/^[/\\]{2}/.test(path)) return fallback
    if (new URL(path, origin).origin !== origin) return fallback
    return path
  } catch {
    return fallback
  }
}
