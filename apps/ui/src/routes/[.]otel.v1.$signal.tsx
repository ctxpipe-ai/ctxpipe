import { createFileRoute } from "@tanstack/react-router"
import { proxyBrowserOtlp } from "@/lib/otelBrowserProxy"

export const Route = createFileRoute("/.otel/v1/$signal")({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        const signal = params.signal
        if (signal !== "traces" && signal !== "logs") {
          return proxyBrowserOtlp(request, null)
        }
        return proxyBrowserOtlp(request, signal)
      },
    },
  },
})
