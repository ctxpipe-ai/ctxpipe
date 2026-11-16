/**
 * Telemetry text must not leave the UI server with a query string, fragment,
 * reset-password or invitation path segment, or email. The browser OTLP relay
 * (`otelBrowserScrub.ts`) and the server SDK (`serverTelemetry.ts`) use it.
 */
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const EMBEDDED_URL = /https?:\/\/[^\s<>"']+|\/[^\s<>"']+/g

function redactSecretPath(value: string): string {
  return value
    .replace(/\/reset-password\/[^/?#]+/g, "/reset-password/{token}")
    .replace(
      /\/public\/invitations\/[^/?#]+/g,
      "/public/invitations/{invitation}",
    )
}

/** Drop query, fragment, and userinfo, then redact credential path segments. */
function scrubTelemetryUrl(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value)
      url.search = ""
      url.hash = ""
      url.username = ""
      url.password = ""
      const path = redactSecretPath(url.pathname || "/")
      return `${url.origin}${path}`
    } catch {
      // Fall through to the path trimmer.
    }
  }
  const cut = value.split(/[?#]/, 1)[0] ?? value
  return redactSecretPath(cut)
}

export function scrubTelemetryString(value: string): string {
  return value
    .replace(EMBEDDED_URL, (part) => scrubTelemetryUrl(part))
    .replace(EMAIL, "{email}")
}
