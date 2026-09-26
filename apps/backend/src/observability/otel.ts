import type { RequestOptions } from "node:http"
import {
  type Context,
  context,
  isSpanContextValid,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis"
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node"
import {
  type MetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { log } from "evlog"
import type { Env } from "../config/env.js"
import { baggageWithAttribution, copyAttributionToSpan } from "./attribution.js"
import { BetterAuthSpanFilter } from "./betterAuthSpanFilter.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import { LangfuseContextSpanProcessor } from "./langfuseContextProcessor.js"
import { redactSecretPath } from "./secretPath.js"

let sdk: NodeSDK | undefined
let spanProcessor: SpanProcessor | undefined
let metricReader: MetricReader | undefined
let started = false
let outgoingFetchInstrumented = false

/** evlog `service` name. NodeSDK reads `OTEL_SERVICE_NAME` on its own. */
export function otelServiceName(
  configured = process.env.OTEL_SERVICE_NAME,
): string {
  const name = configured?.trim()
  return name ? name : "backend"
}

/**
 * Railway sets `RAILWAY_ENVIRONMENT_NAME` (`production` or `pr-N`).
 * Local / unset falls back to NODE_ENV. The log drain still calls this.
 * The tracer resource comes from env (see `initOtel`).
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
  return /^pr-\d+$/.test(railwayEnvironmentName?.trim() ?? "")
}

const SPAN_URL_KEYS = [
  "url.path",
  "url.full",
  "http.target",
  "http.url",
] as const

/** Strip query, fragment, and userinfo. Secret path segments stay redacted. */
export class AttributionUrlSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    copyAttributionToSpan(span, parentContext)
    const attributes = (span as { attributes?: Record<string, unknown> })
      .attributes
    if (!attributes) return
    for (const key of SPAN_URL_KEYS) {
      const value = attributes[key]
      if (typeof value !== "string") continue
      const absolute = key === "url.full" || key === "http.url"
      const next = recordedUrl(value, absolute)
      if (next !== value) span.setAttribute(key, next)
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * HTTP `requireParentforOutgoingSpans` records a non-recording span when there
 * is no parent, including on error. Redis `requireParentSpan` returns before
 * `startSpan`, including on error. Redis `connect` does not check that flag,
 * so drop parentless CLIENT/INTERNAL auto-instrumentation spans unless they
 * failed.
 */
export class DropParentlessInstrumentationSpans implements SpanProcessor {
  constructor(private readonly next: SpanProcessor) {}
  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext)
  }
  onEnd(span: ReadableSpan): void {
    const parent = span.parentSpanContext
    const parentless = !parent || !isSpanContextValid(parent)
    const noise =
      parentless &&
      span.status.code !== SpanStatusCode.ERROR &&
      (span.kind === SpanKind.CLIENT || span.kind === SpanKind.INTERNAL) &&
      span.instrumentationScope.name.startsWith(
        "@opentelemetry/instrumentation-",
      )
    if (!noise) this.next.onEnd(span)
  }
  shutdown(): Promise<void> {
    return this.next.shutdown()
  }
  forceFlush(): Promise<void> {
    return this.next.forceFlush()
  }
}

/**
 * Initialize OpenTelemetry tracing and metrics before other tracing imports.
 * `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` are read by NodeSDK.
 * `RAILWAY_ENVIRONMENT_NAME` is prepended as `deployment.environment` so an
 * explicit resource attribute still wins. PR (`pr-N`) metrics flush on demand.
 */
export function initOtel(env: Env): void {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!tracesEndpoint || started) return

  const railwayEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (railwayEnvironment)
    process.env.OTEL_RESOURCE_ATTRIBUTES = `deployment.environment=${railwayEnvironment}${process.env.OTEL_RESOURCE_ATTRIBUTES ? `,${process.env.OTEL_RESOURCE_ATTRIBUTES}` : ""}`

  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint,
    timeoutMillis: 2_000,
  })
  const batch = new BatchSpanProcessor(traceExporter, {
    exportTimeoutMillis: 2_000,
  })
  spanProcessor = new DropParentlessInstrumentationSpans(
    new BetterAuthSpanFilter(batch),
  )
  metricReader = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ? metricReaderFor(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
    : undefined

  sdk = new NodeSDK({
    spanProcessors: [
      new AttributionUrlSpanProcessor(),
      new LangfuseContextSpanProcessor(),
      spanProcessor,
    ],
    instrumentations: [
      new HttpInstrumentation({
        requireParentforOutgoingSpans: true,
        ignoreIncomingRequestHook: () => true,
        ignoreOutgoingRequestHook(request) {
          const url = httpRequestUrl(request)
          return url !== undefined && isOtlpExportUrl(url)
        },
      }),
      new RedisInstrumentation({ requireParentSpan: true }),
      ...(typeof Bun === "undefined" ? [new RuntimeNodeInstrumentation()] : []),
    ],
    ...(metricReader ? { metricReaders: [metricReader] } : {}),
  })
  sdk.start()
  installOutgoingFetchInstrumentation()
  started = true
}

function metricReaderFor(url: string): MetricReader {
  const exporter = new OTLPMetricExporter({ url, timeoutMillis: 2_000 })
  if (isRailwayPrEnvironment()) return new FlushOnDemandMetricReader(exporter)
  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  })
}

const TRACE_SCOPE = "ctxpipe-backend"

export function installOutgoingFetchInstrumentation(): void {
  if (outgoingFetchInstrumented) return
  outgoingFetchInstrumented = true
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    tracedOutgoingFetch(original, input, init)) as typeof fetch
}

/** Child span for outgoing fetch. Skips OTLP export URLs and parentless calls. */
export async function tracedOutgoingFetch(
  original: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  if (isOtlpExportUrl(raw) || !trace.getActiveSpan())
    return original(input, init)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return original(input, init)
  }
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase()
  const internal = internalOrigin(parsed)
  return trace.getTracer(TRACE_SCOPE).startActiveSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "url.full": recordedUrl(raw, true),
        "url.path": recordedUrl(raw, false),
      },
    },
    async (span) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      propagation.inject(
        internal ? baggageWithAttribution(context.active()) : context.active(),
        headers,
        {
          set(carrier, key, value) {
            if (key === "baggage" && !internal) return
            carrier.set(key, value)
          },
        },
      )
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
    },
  )
}

function recordedUrl(value: string, absolute: boolean): string {
  try {
    const parsed = new URL(value)
    const path = redactSecretPath(parsed.pathname || "/")
    return absolute ? `${parsed.origin}${path}` : path
  } catch {
    return redactSecretPath(value.split("#")[0]?.split("?")[0] ?? value)
  }
}

function internalOrigin(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "railway.internal" ||
    host.endsWith(".railway.internal")
  ) {
    return true
  }
  const configured = process.env.CODESEARCH_URL
  if (!configured) return false
  return configured.split(",").some((entry) => {
    try {
      return new URL(entry.trim()).origin === url.origin
    } catch {
      return false
    }
  })
}

function isOtlpExportUrl(url: string): boolean {
  for (const endpoint of [
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  ]) {
    const base = endpoint?.trim().replace(/\/$/, "")
    if (!base) continue
    if (
      url === base ||
      url.startsWith(`${base}/`) ||
      url.startsWith(`${base}?`)
    ) {
      return true
    }
  }
  return false
}

function httpRequestUrl(request: RequestOptions): string | undefined {
  const path = request.path ?? "/"
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  const hostname = request.hostname || request.host?.split(":")[0]
  if (!hostname) return undefined
  const protocol = (request.protocol || "https:").replace(/:$/, "")
  const port =
    request.port == null || request.port === "" ? "" : String(request.port)
  const suffix =
    port &&
    !(
      (protocol === "https" && port === "443") ||
      (protocol === "http" && port === "80")
    )
      ? `:${port}`
      : ""
  return `${protocol}://${hostname}${suffix}${path.startsWith("/") ? path : `/${path}`}`
}

/** Flush the span processor and metric reader created by `initOtel`. */
export async function forceFlushOtel(): Promise<void> {
  if (!spanProcessor && !metricReader) return
  try {
    await Promise.all([spanProcessor?.forceFlush(), metricReader?.forceFlush()])
  } catch (error) {
    log.error({
      step: "otel.flush",
      message: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.name : "Error",
    })
  }
}

/** Shutdown the OTEL SDK. Call on process exit. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return
  await sdk.shutdown()
  sdk = undefined
  spanProcessor = undefined
  metricReader = undefined
  started = false
}
