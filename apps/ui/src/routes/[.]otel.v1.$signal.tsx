import { createFileRoute } from "@tanstack/react-router"
import { drainRequestBody, proxyBrowserOtlp } from "@/lib/otelBrowserProxy"

export const Route = createFileRoute("/.otel/v1/$signal")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const signal = params.signal
        if (signal !== "traces" && signal !== "logs") {
          await drainRequestBody(request)
          return new Response(null, { status: 404 })
        }
        const upstream = (
          signal === "logs"
            ? process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
            : process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        )?.trim()
        if (!upstream) {
          await drainRequestBody(request)
          return new Response(null, { status: 204 })
        }
        return proxyBrowserOtlp(request, upstream)
      },
    },
  },
})
