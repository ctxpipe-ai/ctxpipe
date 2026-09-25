import { getHyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import {
  OTEL_PROXY_MAX_BODY_BYTES,
  otelCollectorBaseUrl,
  otelProxyAdmission,
  otelProxyUpstreamUrl,
  parseOtelHeaders,
} from "@/lib/otelBrowserConfig"

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
  const search = new URL(request.url).search
  return new URL(`${pathname}${search}`, "https://browser.local").href
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
  status: 404 | 405 | 413,
): Promise<Response> {
  if (status !== 413) await drainRequestBody(request)
  return new Response(null, {
    status,
    headers: status === 405 ? { Allow: "POST" } : undefined,
  })
}

/**
 * `pathname` is the router pathname (`/.otel/...`). Admission uses it instead
 * of `request.url`, which a proxy can rewrite before this handler runs.
 */
export async function proxyBrowserOtlp(
  request: Request,
  pathname?: string,
): Promise<Response> {
  if (!getHyperDxRuntimeConfig().enabled) {
    return reject(request, 404)
  }

  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) {
    return reject(request, 404)
  }

  const declared = declaredBodyBytes(request)
  const admission = otelProxyAdmission(
    request.method,
    admissionUrl(request, pathname),
    declared ?? 0,
  )
  if (!admission.allow) {
    return reject(request, admission.status)
  }

  const body = await readBodyCapped(request, OTEL_PROXY_MAX_BODY_BYTES)
  if (body === "too_large") {
    return new Response(null, { status: 413 })
  }

  const collectorBase = otelCollectorBaseUrl(traces)
  const upstreamUrl = otelProxyUpstreamUrl(
    collectorBase,
    admissionUrl(request, pathname),
  )
  const otelHeaders = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const headers: Record<string, string> = {
    ...otelHeaders,
    "Content-Type": request.headers.get("Content-Type") || "application/json",
  }
  const contentEncoding = request.headers.get("Content-Encoding")
  if (contentEncoding) {
    headers["Content-Encoding"] = contentEncoding
  }

  let response: Response
  try {
    response = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
    })
  } catch {
    return new Response(null, { status: 502 })
  }

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") || "application/json",
    },
  })
}
