import { createFileRoute } from "@tanstack/react-router"
import { proxyBrowserOtlp } from "@/lib/otelBrowserProxy"

const handle = ({
  request,
  pathname,
}: {
  request: Request
  pathname: string
}) => proxyBrowserOtlp(request, pathname)

export const Route = createFileRoute("/.otel/$")({
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
