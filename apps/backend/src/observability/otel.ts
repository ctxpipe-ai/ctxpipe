import { metrics, trace } from "@opentelemetry/api"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import type { Env } from "../config/env.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"

let sdk: NodeSDK | undefined

const PR_ENVIRONMENT_RE = /^pr-\d+$/
const FORCE_FLUSH_TIMEOUT_MS = 2_000

/**
 * Railway sets `RAILWAY_ENVIRONMENT_NAME` (`production` or `pr-N`).
 * Local / unset falls back to NODE_ENV.
 */
export function otelDeploymentEnvironment(
  railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME,
  nodeEnv = process.env.NODE_ENV,
): string {
  const name = railwayEnvironmentName?.trim()
  if (name) return name
  return nodeEnv === "production" ? "production" : "development"
}

export function isRailwayPrEnvironment(
  railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME,
): boolean {
  return PR_ENVIRONMENT_RE.test(railwayEnvironmentName?.trim() ?? "")
}

/**
 * Initialize OpenTelemetry tracing and metrics. Call before any other imports that use tracing.
 * When OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, traces are exported via OTLP.
 * When OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set, metrics are exported via OTLP.
 * Production uses a 60s periodic metric reader. PR (`pr-N`) uses flush-on-demand only.
 */
export function initOtel(env: Env): void {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!tracesEndpoint) return

  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-backend"
  const deploymentEnvironment = otelDeploymentEnvironment()

  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint.endsWith("/v1/traces")
      ? tracesEndpoint
      : `${tracesEndpoint.replace(/\/$/, "")}/v1/traces`,
    headers,
  })

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "service.namespace": "ctxpipe",
    "deployment.environment": deploymentEnvironment,
  })

  const metricReaders = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ? [
        createMetricReader(
          env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
          headers,
          isRailwayPrEnvironment(),
        ),
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

function createMetricReader(
  metricsEndpoint: string,
  headers: Record<string, string>,
  prEnvironment: boolean,
) {
  const exporter = new OTLPMetricExporter({
    url: metricsEndpoint.endsWith("/v1/metrics")
      ? metricsEndpoint
      : `${metricsEndpoint.replace(/\/$/, "")}/v1/metrics`,
    headers,
  })
  if (prEnvironment) {
    return new FlushOnDemandMetricReader(exporter)
  }
  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  })
}

export function parseOtelHeaders(
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
 * Flush traces and metrics. PR HTTP/job paths call this after work so metrics
 * export without a 60s timer. Failures are swallowed (non-fatal, short timeout).
 */
export async function forceFlushOtel(): Promise<void> {
  if (!sdk) return
  try {
    await Promise.race([
      Promise.all([
        flushOtelProvider(trace.getTracerProvider()),
        flushOtelProvider(metrics.getMeterProvider()),
      ]),
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("otel forceFlush timeout")),
          FORCE_FLUSH_TIMEOUT_MS,
        )
      }),
    ])
  } catch {
    /* collector slow or unreachable — do not fail the request/job */
  }
}

function flushOtelProvider(provider: object): Promise<void> {
  const flushable = provider as { forceFlush?: () => Promise<void> }
  return flushable.forceFlush?.() ?? Promise.resolve()
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
