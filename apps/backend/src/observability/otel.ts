import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import type { Env } from "../config/env.js"
import { copyAttributionToSpan, propagationHeaders } from "./attribution.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import { LangfuseContextSpanProcessor } from "./langfuseContextProcessor.js"
import {
  heapSpaceStatisticsAvailable,
  installProcessHeapGauges,
  omitUnimplementedHeapSpaceCollector,
  reportTelemetrySetupError,
} from "./runtimeMetrics.js"

let sdk: NodeSDK | undefined
let started = false
let outgoingFetchInstrumented = false

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
  if (!tracesEndpoint || started) return

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

  const instrumentations = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-http": {
      ignoreOutgoingRequestHook(request) {
        return isOtlpExportTarget(request.path)
      },
    },
    "@opentelemetry/instrumentation-undici": {
      ignoreRequestHook(request) {
        return isOtlpExportTarget(request.path)
      },
    },
  })
  try {
    if (!heapSpaceStatisticsAvailable()) {
      for (const instrumentation of instrumentations) {
        if (
          instrumentation.instrumentationName ===
          "@opentelemetry/instrumentation-runtime-node"
        ) {
          omitUnimplementedHeapSpaceCollector(instrumentation)
        }
      }
    }
  } catch (error) {
    reportTelemetrySetupError(error)
  }

  sdk = new NodeSDK({
    resource,
    spanProcessors: [
      {
        onStart(span, parentContext) {
          copyAttributionToSpan(span, parentContext)
        },
        onEnd() {},
        shutdown() {
          return Promise.resolve()
        },
        forceFlush() {
          return Promise.resolve()
        },
      },
      new LangfuseContextSpanProcessor(),
      new BatchSpanProcessor(traceExporter),
    ],
    instrumentations,
    ...(metricReaders && { metricReaders }),
  })
  sdk.start()
  try {
    if (
      !heapSpaceStatisticsAvailable() &&
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ) {
      installProcessHeapGauges(metrics.getMeter("ctxpipe-runtime"))
    }
  } catch (error) {
    reportTelemetrySetupError(error)
  }
  installOutgoingFetchInstrumentation()
  started = true
}

const TRACER_NAME = "ctxpipe-backend"

/**
 * Child spans for outgoing fetch, plus W3C traceparent and baggage injection.
 * Bun's fetch is not undici, so `@opentelemetry/instrumentation-undici` does not see it.
 * OTLP export URLs are left uninstrumented so export does not trace itself.
 */
export function installOutgoingFetchInstrumentation(): void {
  if (outgoingFetchInstrumented) return
  outgoingFetchInstrumented = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    if (isOtlpExportUrl(url)) return original(input, init)

    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET")
    const tracer = trace.getTracer(TRACER_NAME)
    const span = tracer.startSpan(`HTTP ${method}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.full": url,
      },
    })
    copyAttributionToSpan(span, context.active())
    return context.with(trace.setSpan(context.active(), span), async () => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      propagationHeaders(headers)
      const request = new Request(input, { ...init, headers })
      try {
        const response = await original(request)
        span.setAttribute("http.response.status_code", response.status)
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR })
        }
        return response
      } catch (error) {
        if (error instanceof Error) span.recordException(error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        span.end()
      }
    })
  }) as typeof fetch
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export function isOtlpExportTarget(value: string | null | undefined): boolean {
  if (!value) return false
  let path = value
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      path = new URL(value).pathname
    } catch {
      path = value
    }
  }
  const pathname = path.split("?")[0] ?? path
  return /\/v1\/(traces|metrics|logs)\/?$/.test(pathname)
}

function isOtlpExportUrl(url: string): boolean {
  return isOtlpExportTarget(url)
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
    started = false
  }
}
