import {
  restrictBrowserResourceAttributes,
  scrubOtlpJsonText,
} from "@/lib/otelBrowserScrub"

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Public origin the browser used. Behind the backend SPA proxy, `request.url`
 * is the private UI host and `X-Forwarded-Host` is the public host.
 */
function browserOrigin(request: Request): string | null {
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
  try {
    if (!forwardedHost) return new URL(request.url).origin
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https"
    return new URL(`${proto}://${forwardedHost}`).origin
  } catch {
    return null
  }
}

/**
 * Bun will not flush an error response while a POST body is still unread, and
 * cancelling that stream makes the backend proxy see a socket close.
 */
export async function drainRequestBody(request: Request): Promise<void> {
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

async function reject(
  request: Request,
  status: 400 | 403 | 411 | 413 | 415,
): Promise<Response> {
  await drainRequestBody(request)
  return new Response(null, { status })
}

/**
 * `OTEL_*` lists are comma-separated `key=value` pairs. Split on the first `=`,
 * trim, percent-decode. Same rules as the OTel SDK header parser. `+` stays `+`.
 */
function parseOtelKeyValueList(raw: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    if (eq < 0) continue
    const key = percentDecode(entry.slice(0, eq).trim())
    if (!key) continue
    pairs.push([key, percentDecode(entry.slice(eq + 1).trim())])
  }
  return pairs
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Railway name, else the last `deployment.environment`, else NODE_ENV. */
function deploymentEnvironment(): string {
  const railway = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (railway) return railway
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES?.trim()
  if (raw) {
    let named: string | undefined
    for (const [key, value] of parseOtelKeyValueList(raw)) {
      if (key === "deployment.environment" && value) named = value
    }
    if (named) return named
  }
  return process.env.NODE_ENV === "production" ? "production" : "development"
}

export async function proxyBrowserOtlp(
  request: Request,
  upstream: string,
): Promise<Response> {
  const origin = browserOrigin(request)
  if (!origin || request.headers.get("origin") !== origin) {
    return reject(request, 403)
  }
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase()
  if (encoding && encoding !== "identity") return reject(request, 415)
  if (!request.body) return new Response(null, { status: 204 })

  const rawLength = request.headers.get("content-length")
  if (rawLength == null || rawLength.trim() === "") return reject(request, 411)
  const declared = Number(rawLength)
  if (!Number.isInteger(declared) || declared < 0) return reject(request, 411)
  if (declared === 0) {
    await drainRequestBody(request)
    return new Response(null, { status: 204 })
  }
  if (declared > MAX_BODY_BYTES) return reject(request, 413)

  const contentType = request.headers.get("content-type") || "application/json"
  if (!contentType.toLowerCase().includes("json")) {
    return reject(request, 415)
  }

  const text = await request.text()
  let decoded: unknown
  try {
    decoded = scrubOtlpJsonText(text)
  } catch {
    return new Response(null, { status: 400 })
  }
  restrictBrowserResourceAttributes(decoded, deploymentEnvironment())
  return forward(upstream, JSON.stringify(decoded))
}

async function forward(upstream: string, payload: string): Promise<Response> {
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim()
  const headers: Record<string, string> = {}
  if (rawHeaders) {
    for (const [key, value] of parseOtelKeyValueList(rawHeaders)) {
      headers[key] = value
    }
  }
  headers["Content-Type"] = "application/json"
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
