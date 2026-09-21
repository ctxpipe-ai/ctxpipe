/** Same-origin OTLP proxy for `@hyperdx/browser` (dot-route, like `/.auth/*`). */
export const OTEL_BROWSER_INGEST_PATH = "/.otel"

/**
 * Strip a signal suffix so `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` can be the
 * collector base used by the browser proxy.
 */
export function otelCollectorBaseUrl(endpoint: string): string {
  return endpoint
    .trim()
    .replace(/\/v1\/(traces|logs|metrics)\/?$/i, "")
    .replace(/\/$/, "")
}

export function parseOtelHeaders(
  headerStr: string | undefined,
): Record<string, string> {
  if (!headerStr?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of headerStr.split(",")) {
    const eq = part.indexOf("=")
    if (eq > 0) {
      const key = part.slice(0, eq).trim()
      const value = part
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      if (key && value) out[key] = decodeURIComponent(value)
    }
  }
  return out
}

export function otelProxyUpstreamUrl(
  collectorBase: string,
  requestUrl: string,
): string {
  const incoming = new URL(requestUrl)
  const suffix = incoming.pathname
    .replace(/^\/\.otel\/?/, "/")
    .replace(/\/$/, "")
  const path = suffix === "" ? "/v1/traces" : suffix
  return `${collectorBase}${path}${incoming.search}`
}
