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
  reportTelemetryFlushError,
  reportTelemetrySetupError,
} from "./runtimeMetrics.js"
import { redactSecretPath } from "./secretPath.js"

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

  const instrumentations = getNodeAutoInstrumentations(
    nodeAutoInstrumentationConfig(),
  )
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
          redactSpanUrlAttributes(span)
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
 * Auto-instrumentations shared by the API (`bun src/server.ts`) and the
 * OpenWorkflow worker. The worker supervisor is Bun, and it starts
 * `bunx @openworkflow/cli worker start`. That CLI is `#!/usr/bin/env node`,
 * and the worker image puts Node on PATH, so the config runs on Node.
 * `openworkflow.config.ts` imports `register.ts` (which enables these
 * instrumentations) before `pg` loads. On Node that hook patches `pg` and
 * emits `pg.query:*` / `pg.connect` / `pg-pool.connect` beside the spans from
 * `dbTrace`. On Bun the same hook does not patch `pg` once it is already
 * loaded, which is why the API process did not double-count. Disable
 * instrumentation-pg so `dbTrace` is the only Postgres span source on both
 * runtimes. It also records `db.client.operation.duration` and
 * `db.client.connection.*`; nothing in the HyperDX dashboards reads those.
 */
export function nodeAutoInstrumentationConfig() {
  return {
    "@opentelemetry/instrumentation-pg": { enabled: false },
    "@opentelemetry/instrumentation-http": {
      ignoreOutgoingRequestHook(
        request: Parameters<typeof httpClientRequestUrl>[0],
      ) {
        return isOtlpExportTarget(httpClientRequestUrl(request))
      },
    },
    "@opentelemetry/instrumentation-undici": {
      ignoreRequestHook(request: { origin: string; path: string }) {
        return isOtlpExportTarget(`${request.origin}${request.path}`)
      },
    },
  }
}

/**
 * Child spans for outgoing fetch, plus W3C traceparent and baggage injection.
 * Bun's fetch is not undici, so `@opentelemetry/instrumentation-undici` does not see it.
 * OTLP export URLs are left uninstrumented so export does not trace itself.
 */
export function installOutgoingFetchInstrumentation(): void {
  if (outgoingFetchInstrumented) return
  outgoingFetchInstrumented = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    tracedOutgoingFetch(original, input, init)) as typeof fetch
}

/**
 * Client span for one outgoing fetch.
 * No span when nothing is already tracing (UI proxy documents and assets),
 * when the target is the UI proxy, or when the URL is an OTLP export.
 * Recorded URLs keep scheme, host, and path only.
 */
export async function tracedOutgoingFetch(
  original: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input)
  if (
    isOtlpExportUrl(url) ||
    isUiProxyFetchTarget(url) ||
    !trace.getActiveSpan()
  ) {
    return original(input, init)
  }

  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET")
  const tracer = trace.getTracer(TRACER_NAME)
  const span = tracer.startSpan(`HTTP ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": method,
      ...sanitizedClientUrlAttributes(url),
    },
  })
  copyAttributionToSpan(span, context.active())
  return context.with(trace.setSpan(context.active(), span), async () => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    propagationHeaders(headers)
    let request: Request
    try {
      request = new Request(input, { ...init, headers })
    } catch {
      try {
        return await original(input, init)
      } finally {
        span.end()
      }
    }
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
}

function redactSpanUrlAttributes(span: {
  setAttribute(key: string, value: string): void
}): void {
  const attributes = (span as { attributes?: Record<string, unknown> })
    .attributes
  if (!attributes) return
  for (const key of ["url.path", "url.full", "http.target", "http.url"]) {
    const value = attributes[key]
    if (typeof value !== "string") continue
    const redacted = redactSecretPath(value)
    if (redacted !== value) span.setAttribute(key, redacted)
  }
}

/** scheme, host, and path. Query, fragment, and userinfo are omitted. */
export function sanitizedClientUrlAttributes(
  raw: string,
): Record<string, string> {
  try {
    const parsed = new URL(raw)
    const path = redactSecretPath(parsed.pathname || "/")
    const scheme = parsed.protocol.replace(/:$/, "")
    return {
      "url.scheme": scheme,
      "server.address": parsed.hostname,
      "url.path": path,
      "url.full": `${parsed.protocol}//${parsed.host}${path}`,
    }
  } catch {
    const path = redactSecretPath(raw.split("#")[0]?.split("?")[0] ?? raw)
    return { "url.path": path }
  }
}

export function isUiProxyFetchTarget(
  raw: string,
  proxyBase = process.env.UI_PROXY_URL,
): boolean {
  if (!proxyBase) return false
  try {
    return new URL(raw).origin === new URL(proxyBase).origin
  } catch {
    return false
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function signalExportUrl(
  raw: string | undefined,
  signalPath: string,
): URL | undefined {
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    const path = parsed.pathname.replace(/\/$/, "")
    if (/\/v1\/(traces|metrics|logs)$/.test(path)) return parsed
    return new URL(signalPath, raw.endsWith("/") ? raw : `${raw}/`)
  } catch {
    return undefined
  }
}

function configuredOtlpExportUrls(): URL[] {
  return [
    signalExportUrl(
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      "/v1/traces",
    ),
    signalExportUrl(
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      "/v1/metrics",
    ),
    signalExportUrl(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "/v1/logs"),
  ].filter((url): url is URL => url !== undefined)
}

function httpClientRequestUrl(request: {
  protocol?: string | null
  hostname?: string | null
  host?: string | null
  port?: string | number | null
  path?: string | null
}): string | undefined {
  const path = request.path ?? "/"
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  const hostname = request.hostname ?? request.host?.split(":")[0]
  if (!hostname) return undefined
  const protocol = (request.protocol || "https:").replace(/:$/, "")
  const port = request.port == null ? "" : String(request.port)
  const defaultPort =
    (protocol === "https" && port === "443") ||
    (protocol === "http" && port === "80")
  const portSuffix = port && !defaultPort ? `:${port}` : ""
  const pathname = path.startsWith("/") ? path : `/${path}`
  return `${protocol}://${hostname}${portSuffix}${pathname}`
}

/** True only for this process's configured OTLP trace, metric, or log export URL. */
export function isOtlpExportTarget(value: string | null | undefined): boolean {
  if (!value) return false
  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    return false
  }
  const path = candidate.pathname.replace(/\/$/, "") || "/"
  return configuredOtlpExportUrls().some((target) => {
    const targetPath = target.pathname.replace(/\/$/, "") || "/"
    return target.origin === candidate.origin && targetPath === path
  })
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
  } catch (error) {
    reportTelemetryFlushError(error)
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
