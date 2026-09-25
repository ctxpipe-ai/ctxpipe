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
  const path = otelProxySignalPath(requestUrl)
  return `${collectorBase}${path}${incoming.search}`
}

/** OTLP signal paths the browser proxy will forward. */
export const OTEL_PROXY_SIGNAL_PATHS = [
  "/v1/traces",
  "/v1/logs",
  "/v1/metrics",
] as const

/** 1 MiB. Larger browser exports are rejected before they are proxied. */
export const OTEL_PROXY_MAX_BODY_BYTES = 1024 * 1024

const otelProxySignalPathSet = new Set<string>(OTEL_PROXY_SIGNAL_PATHS)

/**
 * Path after `/.otel`, with a trailing slash removed.
 * `https://app/.otel/v1/logs/` → `/v1/logs`. `https://app/.otel` → `""`.
 */
export function otelProxySignalPath(requestUrl: string): string {
  const pathname = new URL(requestUrl).pathname
  let suffix = pathname.replace(/^\/\.otel(?=\/|$)/, "")
  if (suffix === "" || suffix === "/") return ""
  if (suffix.endsWith("/")) suffix = suffix.slice(0, -1)
  return suffix
}

export type OtelProxyAdmission =
  | { allow: true }
  | { allow: false; status: 404 | 405 | 413 }

/** Path allowlist, then POST-only, then body cap. Wrong paths are 404 even for non-POST. */
export function otelProxyAdmission(
  method: string,
  requestUrl: string,
  bodyBytes: number,
): OtelProxyAdmission {
  const signalPath = otelProxySignalPath(requestUrl)
  if (!otelProxySignalPathSet.has(signalPath)) {
    return { allow: false, status: 404 }
  }
  if (method.toUpperCase() !== "POST") {
    return { allow: false, status: 405 }
  }
  if (bodyBytes > OTEL_PROXY_MAX_BODY_BYTES) {
    return { allow: false, status: 413 }
  }
  return { allow: true }
}
