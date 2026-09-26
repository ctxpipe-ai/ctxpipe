import { getHyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import {
  OTEL_PROXY_MAX_BODY_BYTES,
  otelCollectorBaseUrl,
  otelProxyAdmission,
  otelProxyUpstreamUrl,
  parseOtelHeaders,
} from "@/lib/otelBrowserConfig"
import {
  OtelScrubDepthError,
  restrictBrowserResourceAttributes,
  scrubBrowserOtlpJson,
} from "@/lib/otelBrowserScrub"

const RATE_CAPACITY = 60
const RATE_WINDOW_MS = 60_000

type RateBucket = { tokens: number; updatedAt: number }
const rateBuckets = new Map<string, RateBucket>()

export function resetOtelBrowserProxyRateLimitForTests(): void {
  rateBuckets.clear()
}

export function otelBrowserProxyRateBucketCountForTests(): number {
  return rateBuckets.size
}

let rateBucketCapForTests = 10_000

export function setOtelBrowserProxyRateBucketCapForTests(cap: number): void {
  rateBucketCapForTests = cap
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first || "unknown"
}

function bucketIsIdle(bucket: RateBucket, now: number): boolean {
  const refilled =
    bucket.tokens + ((now - bucket.updatedAt) * RATE_CAPACITY) / RATE_WINDOW_MS
  return refilled >= RATE_CAPACITY
}

function pruneRateBuckets(now: number): void {
  for (const [ip, bucket] of rateBuckets) {
    if (bucketIsIdle(bucket, now)) rateBuckets.delete(ip)
  }
  if (rateBuckets.size <= rateBucketCapForTests) return
  const oldest = [...rateBuckets.entries()].sort(
    (left, right) => left[1].updatedAt - right[1].updatedAt,
  )
  for (const [ip] of oldest) {
    if (rateBuckets.size <= rateBucketCapForTests) break
    rateBuckets.delete(ip)
  }
}

function takeRateToken(ip: string): boolean {
  const now = Date.now()
  pruneRateBuckets(now)
  const bucket = rateBuckets.get(ip) ?? {
    tokens: RATE_CAPACITY,
    updatedAt: now,
  }
  const refilled =
    bucket.tokens + ((now - bucket.updatedAt) * RATE_CAPACITY) / RATE_WINDOW_MS
  bucket.tokens = Math.min(RATE_CAPACITY, refilled)
  bucket.updatedAt = now
  if (bucket.tokens < 1) {
    rateBuckets.set(ip, bucket)
    if (rateBuckets.size > rateBucketCapForTests) pruneRateBuckets(now)
    return false
  }
  bucket.tokens -= 1
  rateBuckets.set(ip, bucket)
  if (rateBuckets.size > rateBucketCapForTests) pruneRateBuckets(now)
  return true
}

function headerFirst(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? ""
}

/**
 * Behind the backend SPA proxy, `request.url` is the private UI host.
 * `X-Forwarded-Host` is set by that proxy from the public request URL.
 * Direct UI access (local Vite) has no forwarded host, so the request host is used.
 */
export function browserFacingOrigin(request: Request): string | null {
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

async function readBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "too_large"> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return "too_large"
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function declaredBodyBytes(request: Request): number | null {
  const raw = request.headers.get("content-length")
  if (raw == null || raw.trim() === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function admissionUrl(request: Request, pathname?: string): string {
  if (!pathname) return request.url
  return new URL(pathname, "https://browser.local").href
}

/**
 * Bun will not flush an error response while a POST body is still unread, and
 * cancelling that stream makes the backend proxy see a socket close. Read the
 * small reject body, then answer.
 */
async function drainRequestBody(request: Request): Promise<void> {
  if (!request.body) return
  const reader = request.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      total += value?.byteLength ?? 0
      if (total > OTEL_PROXY_MAX_BODY_BYTES) {
        await reader.cancel()
        return
      }
    }
  } catch {
    // The sender already finished or aborted.
  }
}

async function reject(
  request: Request,
  status: 403 | 404 | 405 | 413 | 415 | 429,
): Promise<Response> {
  if (status !== 413) await drainRequestBody(request)
  return new Response(null, {
    status,
    headers: status === 405 ? { Allow: "POST" } : undefined,
  })
}

/** No collector configured. Swallow the body so the caller sees success, not an error. */
async function otelDisabled(request: Request): Promise<Response> {
  await drainRequestBody(request)
  return new Response(null, { status: 204 })
}

function decodeOtlpBody(
  body: Uint8Array,
  contentType: string,
): unknown | "empty" | "malformed" | "unsupported" {
  if (!contentType.toLowerCase().includes("json")) return "unsupported"
  if (body.byteLength === 0) return "empty"
  const text = new TextDecoder().decode(body)
  try {
    return JSON.parse(text) as unknown
  } catch {
    return "malformed"
  }
}

/**
 * `pathname` is the router pathname (`/.otel/...`). Admission uses it instead
 * of `request.url`, which a proxy can rewrite before this handler runs.
 * The browser SDK posts `application/json` with no Content-Encoding. The gzip
 * header in the SDK bundle belongs to the disabled session-replay beacon.
 */
export async function proxyBrowserOtlp(
  request: Request,
  pathname?: string,
): Promise<Response> {
  const config = getHyperDxRuntimeConfig()
  if (!config.enabled) {
    return otelDisabled(request)
  }

  const configuredTraces =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!configuredTraces) {
    return otelDisabled(request)
  }
  const tracesEndpoint: string = configuredTraces

  const declared = declaredBodyBytes(request)
  const admission = otelProxyAdmission(
    request.method,
    admissionUrl(request, pathname),
    declared ?? 0,
  )
  if (!admission.allow) {
    return reject(request, admission.status)
  }
  if (!isSameOrigin(request)) {
    return reject(request, 403)
  }
  if (!takeRateToken(clientIp(request))) {
    return reject(request, 429)
  }

  const body = await readBodyCapped(request, OTEL_PROXY_MAX_BODY_BYTES)
  if (body === "too_large") {
    return new Response(null, { status: 413 })
  }
  if (rejectedContentEncoding(request)) {
    return new Response(null, { status: 415 })
  }

  const contentType = request.headers.get("Content-Type") || "application/json"
  const decoded = decodeOtlpBody(body, contentType)
  if (decoded === "empty") {
    return new Response(null, { status: 204 })
  }
  if (decoded === "malformed") {
    return new Response(null, { status: 400 })
  }
  if (decoded === "unsupported") {
    return new Response(null, { status: 415 })
  }
  try {
    scrubBrowserOtlpJson(decoded)
    restrictBrowserResourceAttributes(decoded, config.environment)
  } catch (error) {
    if (error instanceof OtelScrubDepthError || error instanceof RangeError) {
      return new Response(null, { status: 400 })
    }
    throw error
  }
  const encoded = new TextEncoder().encode(JSON.stringify(decoded))
  return forward(encoded)

  function forward(payload: Uint8Array): Promise<Response> {
    const collectorBase = otelCollectorBaseUrl(tracesEndpoint)
    const upstreamUrl = otelProxyUpstreamUrl(
      collectorBase,
      admissionUrl(request, pathname),
    )
    const otelHeaders = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    return fetch(upstreamUrl, {
      method: "POST",
      headers: {
        ...otelHeaders,
        "Content-Type": "application/json",
      },
      body: new Uint8Array(payload),
    })
      .then(async (response) => {
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: {
            "Content-Type":
              response.headers.get("Content-Type") || "application/json",
          },
        })
      })
      .catch(() => new Response(null, { status: 502 }))
  }
}
