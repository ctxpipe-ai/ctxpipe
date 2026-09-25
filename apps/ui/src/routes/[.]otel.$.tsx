import { createFileRoute } from "@tanstack/react-router"
import { proxyBrowserOtlp } from "@/lib/otelBrowserProxy"

const handle = ({ request }: { request: Request }) => proxyBrowserOtlp(request)

export const Route = createFileRoute("/.otel/$")({
  component: () => null,
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
      HEAD: handle,
    },
  },
})
