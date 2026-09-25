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

export async function proxyBrowserOtlp(request: Request): Promise<Response> {
  if (!getHyperDxRuntimeConfig().enabled) {
    return new Response(null, { status: 404 })
  }

  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) {
    return new Response(null, { status: 404 })
  }

  const declared = declaredBodyBytes(request)
  const admission = otelProxyAdmission(
    request.method,
    request.url,
    declared ?? 0,
  )
  if (!admission.allow) {
    return new Response(null, {
      status: admission.status,
      headers: admission.status === 405 ? { Allow: "POST" } : undefined,
    })
  }

  const body = await readBodyCapped(request, OTEL_PROXY_MAX_BODY_BYTES)
  if (body === "too_large") {
    return new Response(null, { status: 413 })
  }

  const collectorBase = otelCollectorBaseUrl(traces)
  const upstreamUrl = otelProxyUpstreamUrl(collectorBase, request.url)
  const otelHeaders = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const headers: Record<string, string> = {
    ...otelHeaders,
    "Content-Type": request.headers.get("Content-Type") || "application/json",
  }
  const contentEncoding = request.headers.get("Content-Encoding")
  if (contentEncoding) {
    headers["Content-Encoding"] = contentEncoding
  }

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: new Uint8Array(body),
  })

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") || "application/json",
    },
  })
}
