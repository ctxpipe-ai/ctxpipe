import { getHyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import {
  otelCollectorBaseUrl,
  otelProxyUpstreamUrl,
  parseOtelHeaders,
} from "@/lib/otelBrowserConfig"

export async function proxyBrowserOtlp(request: Request): Promise<Response> {
  if (!getHyperDxRuntimeConfig().enabled) {
    return new Response(null, { status: 404 })
  }

  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) {
    return new Response(null, { status: 404 })
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
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
  })

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") || "application/json",
    },
  })
}
