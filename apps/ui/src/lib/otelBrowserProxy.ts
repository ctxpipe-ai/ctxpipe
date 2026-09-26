import {
  restrictBrowserResourceAttributes,
  scrubOtlpJsonText,
} from "@/lib/otelBrowserScrub"

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Flood brake for this process, not a per-user quota.
 *
 * The browser reaches this handler through the backend proxy, which forwards
 * Railway's `X-Forwarded-For` and `X-Real-IP` unchanged. The first
 * X-Forwarded-For entry is client-supplied when the edge appends, and
 * Railway's own answers disagree on whether the client address is the
 * leftmost or rightmost hop. `X-Real-IP` is the CDN edge address while
 * Fastly is in front, so every browser would share it. The backend's TCP
 * peer is that edge, not the browser, so a header stamped from those values
 * is still not a per-client key. One bucket bounds how much this replica
 * forwards; the 1 MiB cap and the collector memory limiter bound the rest.
 */
const RATE_CAPACITY = 1200
const RATE_WINDOW_MS = 60_000

export const OTEL_BROWSER_PROXY_RATE_LIMIT = RATE_CAPACITY

let rateTokens = RATE_CAPACITY
let rateUpdatedAt = Date.now()

export function resetOtelBrowserProxyRateLimitForTests(): void {
  rateTokens = RATE_CAPACITY
  rateUpdatedAt = Date.now()
}

function takeRateToken(): boolean {
  const now = Date.now()
  const refilled =
    rateTokens + ((now - rateUpdatedAt) * RATE_CAPACITY) / RATE_WINDOW_MS
  rateTokens = Math.min(RATE_CAPACITY, refilled)
  rateUpdatedAt = now
  if (rateTokens < 1) return false
  rateTokens -= 1
  return true
}

function headerFirst(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? ""
}

/**
 * Behind the backend SPA proxy, `request.url` is the private UI host.
 * `X-Forwarded-Host` is replaced by that proxy from the public request URL.
 * Direct UI access (local Vite) has no forwarded host, so the request host is used.
 */
function browserFacingOrigin(request: Request): string | null {
  const forwardedHost = headerFirst(request.headers.get("x-forwarded-host"))
  if (forwardedHost) {
    const proto =
      headerFirst(request.headers.get("x-forwarded-proto")) || "https"
    try {
      return new URL(`${proto}://${forwardedHost}`).origin
    } catch {
      return null
    }
  }
  try {
    return new URL(request.url).origin
  } catch {
    return null
  }
}

function isSameOrigin(request: Request): boolean {
  const expected = browserFacingOrigin(request)
  if (!expected) return false
  const origin = request.headers.get("origin")
  if (origin) {
    try {
      return new URL(origin).origin === expected
    } catch {
      return false
    }
  }
  const referer = request.headers.get("referer")
  if (!referer) return false
  try {
    return new URL(referer).origin === expected
  } catch {
    return false
  }
}

function rejectedContentEncoding(request: Request): boolean {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase()
  return Boolean(encoding && encoding !== "identity")
}

/**
 * Bun will not flush an error response while a POST body is still unread, and
 * cancelling that stream makes the backend proxy see a socket close. Read the
 * small reject body, then answer.
 */
async function drainRequestBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return
  const reader = request.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      total += value?.byteLength ?? 0
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        return
      }
    }
  } catch {
    // The sender already finished or aborted.
  }
}

function contentLength(request: Request): number | "missing" | "invalid" {
  const raw = request.headers.get("content-length")
  if (raw == null || raw.trim() === "") return "missing"
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return "invalid"
  return n
}

async function reject(
  request: Request,
  status: 400 | 403 | 411 | 413 | 415 | 429,
): Promise<Response> {
  await drainRequestBody(request)
  return new Response(null, { status })
}

function parseOtelHeaders(
  headerStr: string | undefined,
): Record<string, string> {
  if (!headerStr?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of headerStr.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
    if (key && value) out[key] = decodeURIComponent(value)
  }
  return out
}

/** Full OTLP URL for this signal, from the UI service's exporter env. */
function signalEndpoint(signal: "traces" | "logs"): string | null {
  const direct =
    signal === "logs"
      ? process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      : process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const trimmed = direct?.trim()
  if (trimmed) return trimmed
  if (signal === "traces") return null
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) return null
  const base = traces
    .replace(/\/v1\/(traces|logs|metrics)\/?$/i, "")
    .replace(/\/$/, "")
  return `${base}/v1/logs`
}

/**
 * `signal` is the route param. `null` is any other `/.otel/v1/$signal` value.
 * No collector for this signal answers 204 so the browser SDK does not retry.
 */
export async function proxyBrowserOtlp(
  request: Request,
  signal: "traces" | "logs" | null,
): Promise<Response> {
  if (signal == null) {
    await drainRequestBody(request)
    return new Response(null, { status: 404 })
  }

  const upstream = signalEndpoint(signal)
  if (!upstream) {
    await drainRequestBody(request)
    return new Response(null, { status: 204 })
  }
  if (!isSameOrigin(request)) return reject(request, 403)
  if (rejectedContentEncoding(request)) return reject(request, 415)
  if (!request.body) return new Response(null, { status: 204 })

  const declared = contentLength(request)
  if (declared === 0) {
    await drainRequestBody(request)
    return new Response(null, { status: 204 })
  }
  if (declared === "missing" || declared === "invalid") {
    return reject(request, 411)
  }
  if (declared > MAX_BODY_BYTES) return reject(request, 413)
  if (!takeRateToken()) return reject(request, 429)

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 })
  }
  const contentType = request.headers.get("content-type") || "application/json"
  if (!contentType.toLowerCase().includes("json")) {
    return new Response(null, { status: 415 })
  }
  if (text.length === 0) return new Response(null, { status: 204 })

  let decoded: unknown
  try {
    decoded = scrubOtlpJsonText(text)
  } catch {
    return new Response(null, { status: 400 })
  }
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  restrictBrowserResourceAttributes(decoded, environment || undefined)
  return forward(upstream, JSON.stringify(decoded))
}

async function forward(upstream: string, payload: string): Promise<Response> {
  const headers = {
    ...parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    "Content-Type": "application/json",
  }
  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers,
      body: payload,
    })
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
      },
    })
  } catch {
    return new Response(null, { status: 502 })
  }
}
