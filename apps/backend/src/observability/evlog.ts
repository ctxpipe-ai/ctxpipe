import type { DrainContext } from "evlog"
import { initLogger } from "evlog"
import { createDrainPipeline } from "evlog/pipeline"
import { createOTLPDrain } from "evlog/otlp"
import type { Env } from "../config/env.js"

/**
 * Initialize evlog. Call early in app bootstrap.
 */
export function initEvlog(env: Env): void {
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-backend"
  initLogger({
    env: {
      service: serviceName,
      environment: env.NODE_ENV,
    },
    pretty: env.NODE_ENV === "development",
  })
}

type DrainWithFlush = ((ctx: DrainContext) => Promise<void>) & { flush: () => Promise<void> }

let evlogDrainInstance: DrainWithFlush | undefined

/**
 * Create evlog drain for Hono. When OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set,
 * returns an OTLP drain with batching and retry. Otherwise returns undefined (stdout only).
 */
export function createEvlogDrain(env: Env): ((ctx: DrainContext) => Promise<void>) | undefined {
  if (!env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return undefined

  // evlog appends /v1/logs; strip it so OTEL_EXPORTER_OTLP_LOGS_ENDPOINT can use full URL
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.replace(/\/v1\/logs\/?$/i, "").replace(/\/$/, "")

  const baseDrain = createOTLPDrain({
    endpoint: baseEndpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? "ctxpipe-backend",
    headers: parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  })

  const pipeline = createDrainPipeline<DrainContext>({
    batch: { size: 50, intervalMs: 5000 },
    retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1000 },
    onDropped: (events, error) => {
      console.error(`[evlog] Dropped ${events.length} events:`, error?.message)
    },
  })

  evlogDrainInstance = pipeline(baseDrain) as unknown as DrainWithFlush
  return evlogDrainInstance
}

/** Flush buffered evlog events. Call on server shutdown. */
export async function flushEvlog(): Promise<void> {
  if (evlogDrainInstance?.flush) {
    await evlogDrainInstance.flush()
    evlogDrainInstance = undefined
  }
}

function parseOtelHeaders(headerStr: string | undefined): Record<string, string> {
  if (!headerStr?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of headerStr.split(",")) {
    const eq = part.indexOf("=")
    if (eq > 0) {
      const key = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
      if (key && value) out[key] = decodeURIComponent(value)
    }
  }
  return out
}
