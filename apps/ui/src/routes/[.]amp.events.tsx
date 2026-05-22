import { createFileRoute } from "@tanstack/react-router"
import {
  amplitudeHttpApiOrigin,
  parseAmplitudeRegion,
} from "@/lib/amplitudeConfig"
import { getAmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"

async function proxyIngest(request: Request): Promise<Response> {
  // return new Response("hi from UI", { status: 200 })
  if (!getAmplitudeRuntimeConfig().enabled) {
    return new Response(null, { status: 404 })
  }

  const region = parseAmplitudeRegion(process.env.AMPLITUDE_REGION)
  const body = await request.text()

  const headers: HeadersInit = {
    "Content-Type": request.headers.get("Content-Type") || "application/json",
  }
  const contentEncoding = request.headers.get("Content-Encoding")
  if (contentEncoding) {
    headers["Content-Encoding"] = contentEncoding
  }
  const userAgent = request.headers.get("User-Agent")
  if (userAgent) {
    headers["User-Agent"] = userAgent
  }

  const upstreamUrl = `${amplitudeHttpApiOrigin(region)}/2/httpapi`
  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body,
  })

  return new Response(await response.text(), { status: response.status })
}

export const Route = createFileRoute("/.amp/events")({
  component: () => null,
  server: {
    handlers: {
      POST: ({ request }) => proxyIngest(request),
      OPTIONS: () => new Response(null, { status: 204 }),
    },
  },
})
