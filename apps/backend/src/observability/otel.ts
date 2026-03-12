import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import type { Env } from "../config/env.js"

let sdk: NodeSDK | undefined

/**
 * Initialize OpenTelemetry tracing and metrics. Call before any other imports that use tracing.
 * When OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, traces are exported via OTLP.
 * When OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set, metrics are exported via OTLP.
 */
export function initOtel(env: Env): void {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!tracesEndpoint) return

  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-backend"

  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint.endsWith("/v1/traces")
      ? tracesEndpoint
      : `${tracesEndpoint.replace(/\/$/, "")}/v1/traces`,
    headers,
  })

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  })

  const metricReaders =
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT.endsWith("/v1/metrics")
                ? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
                : `${env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT.replace(/\/$/, "")}/v1/metrics`,
              headers,
            }),
            exportIntervalMillis: 60_000,
          }),
        ]
      : undefined

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
    ...(metricReaders && { metricReaders }),
  })
  sdk.start()
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

/**
 * Shutdown the OTEL SDK. Call on process exit.
 */
export async function shutdownOtel(): Promise<void> {
  if (sdk) {
    await sdk.shutdown()
    sdk = undefined
  }
}
