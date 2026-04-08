import { createFileRoute } from "@tanstack/react-router"
import {
  AMPLITUDE_INGEST_PROXY_PREFIX,
  amplitudeHttpApiOrigin,
  parseAmplitudeRegion,
} from "@/lib/amplitudeConfig"
import { getAmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"

const FORWARD_BLOCKLIST = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function buildTargetUrl(request: Request): string | null {
  const url = new URL(request.url)
  const prefix = AMPLITUDE_INGEST_PROXY_PREFIX
  if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
    return null
  }
  const rest =
    url.pathname === prefix
      ? ""
      : url.pathname.slice(prefix.length).replace(/^\//, "")
  const region = parseAmplitudeRegion(process.env.AMPLITUDE_REGION)
  const origin = amplitudeHttpApiOrigin(region)
  const target = new URL(origin)
  target.pathname = rest ? `/${rest}` : "/"
  target.search = url.search
  return target.toString()
}

function forwardHeaders(from: Headers): Headers {
  const out = new Headers()
  from.forEach((value, key) => {
    if (!FORWARD_BLOCKLIST.has(key.toLowerCase())) {
      out.append(key, value)
    }
  })
  return out
}

async function proxy(request: Request): Promise<Response> {
  // Without `AMPLITUDE_API_KEY`, do not forward to Amplitude — no outbound analytics from this app.
  if (!getAmplitudeRuntimeConfig().enabled) {
    return new Response(null, { status: 404 })
  }

  const targetUrl = buildTargetUrl(request)
  if (!targetUrl) {
    return new Response("Not Found", { status: 404 })
  }

  const method = request.method
  let body: ArrayBuffer | undefined
  if (method !== "GET" && method !== "HEAD") {
    body = await request.arrayBuffer()
  }

  const upstream = await fetch(targetUrl, {
    method,
    headers: forwardHeaders(request.headers),
    body:
      body !== undefined && body.byteLength > 0
        ? new Uint8Array(body)
        : undefined,
    redirect: "manual",
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
}

export const Route = createFileRoute("/api/v1/t/$")({
  component: () => null,
  server: {
    handlers: {
      GET: ({ request }) => proxy(request),
      POST: ({ request }) => proxy(request),
      PUT: ({ request }) => proxy(request),
      PATCH: ({ request }) => proxy(request),
      DELETE: ({ request }) => proxy(request),
      OPTIONS: ({ request }) => proxy(request),
      HEAD: ({ request }) => proxy(request),
    },
  },
})
