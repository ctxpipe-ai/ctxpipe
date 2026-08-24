import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import type { Env } from "../config/env.js"
import { EvlogSpanExporter } from "./evlog-span-exporter.js"

let sdk: NodeSDK | undefined

/**
 * Initialize OpenTelemetry tracing and metrics. Always starts a tracer so
 * workspace-chat spans can dump to evlog. When OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
 * is set, traces are also exported via OTLP (Langfuse in prod).
 *
 * Pass both processors in `spanProcessors`. NodeSDK ignores `traceExporter`
 * when `spanProcessors` is set. Auto-instrumentations stay off unless OTLP is
 * configured — preview has no traces endpoint, and wrapping `pg` there
 * terminated prepare connections.
 */
export function initOtel(env: Env): void {
  if (sdk) return
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-backend"
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  })
  const spanProcessors = [new SimpleSpanProcessor(new EvlogSpanExporter())]
  if (tracesEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: tracesEndpoint.endsWith("/v1/traces")
            ? tracesEndpoint
            : `${tracesEndpoint.replace(/\/$/, "")}/v1/traces`,
          headers,
        }),
      ),
    )
  }

  const metricReaders = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
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
    spanProcessors,
    ...(tracesEndpoint
      ? { instrumentations: [getNodeAutoInstrumentations()] }
      : {}),
    ...(metricReaders && { metricReaders }),
  })
  sdk.start()
}

function parseOtelHeaders(
  headerStr: string | undefined,
): Record<string, string> {
  if (!headerStr?.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of headerStr.split(",")) {
    const eq = part.indexOf("=")
    if (eq > 0) {
      const key = part.slice(0, eq).trim()
      const value = part
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
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
