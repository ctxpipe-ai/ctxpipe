import { createFileRoute } from "@tanstack/react-router"
import { proxyBrowserOtlp } from "@/lib/otelBrowserProxy"

export const Route = createFileRoute("/.otel/$")({
  component: () => null,
  server: {
    handlers: {
      POST: ({ request }) => proxyBrowserOtlp(request),
      PUT: ({ request }) => proxyBrowserOtlp(request),
      GET: ({ request }) => proxyBrowserOtlp(request),
      OPTIONS: () => new Response(null, { status: 204 }),
    },
  },
})
