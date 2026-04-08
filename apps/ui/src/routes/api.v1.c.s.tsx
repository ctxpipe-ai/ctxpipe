import { createFileRoute } from "@tanstack/react-router"
import { getAmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"

export const Route = createFileRoute("/api/v1/c/s")({
  component: () => null,
  server: {
    handlers: {
      GET: () => {
        // `enabled: false` when no API key — clients must not assume analytics is on.
        const headers = { "Cache-Control": "no-store" } as const
        const cfg = getAmplitudeRuntimeConfig()
        if (!cfg.enabled) {
          return Response.json({ enabled: false as const }, { headers })
        }
        return Response.json(
          {
            enabled: true as const,
            apiKey: cfg.apiKey,
            region: cfg.region,
          },
          { headers },
        )
      },
    },
  },
})
