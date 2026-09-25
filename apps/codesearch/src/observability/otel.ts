import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import type { MiddlewareHandler } from "hono"
import type { Env } from "../config/env.js"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"

let tracerProvider: NodeTracerProvider | undefined
let meterProvider: MeterProvider | undefined
let metricReader: MetricReader | undefined
let started = false
let outgoingFetchInstrumented = false

const PR_ENVIRONMENT_RE = /^pr-\d+$/
const FORCE_FLUSH_TIMEOUT_MS = 2_000
const TRACER_NAME = "ctxpipe-codesearch"

const ATTRIBUTION_KEYS = [
  "request.id",
  "enduser.id",
  "ctxpipe.org.id",
  "ctxpipe.org.slug",
  "ctxpipe.actor.type",
  "ctxpipe.api_key.id",
  "ctxpipe.oauth.client_id",
  "ctxpipe.mcp.tool",
  "ctxpipe.conversation.id",
  "ctxpipe.repository.id",
  "ctxpipe.connection.id",
] as const

export function attributesFromBaggage(
  parent: ReturnType<typeof context.active>,
): Record<string, string> {
  const baggage = propagation.getBaggage(parent)
  if (!baggage) return {}
  const attributes: Record<string, string> = {}
  for (const key of ATTRIBUTION_KEYS) {
    const value = baggage.getEntry(key)?.value
    if (value) attributes[key] = value
  }
  return attributes
}

class BaggageAttributeSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: ReturnType<typeof context.active>): void {
    const attributes = attributesFromBaggage(parentContext)
    if (Object.keys(attributes).length > 0) span.setAttributes(attributes)
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

export function isOtelStarted(): boolean {
  return started
}

/** Metric reader installed by the last `initOtel` call, if metrics export is on. */
export function otelMetricReader(): MetricReader | undefined {
  return metricReader
}

/**
 * Initialize OpenTelemetry tracing and metrics. Call before any other imports that use tracing.
 * When OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, traces are exported via OTLP.
 * When OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set, metrics are exported via OTLP.
 * Production uses a 60s periodic metric reader. PR (`pr-N`) uses flush-on-demand only.
 *
 * Codesearch runs on Bun. `@opentelemetry/sdk-node` auto-instrumentations do not
 * patch Bun.serve or Bun's global fetch, so HTTP server spans and outgoing fetch
 * spans are created manually. Undici instrumentation is not used.
 */
export function initOtel(env: Env): void {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!tracesEndpoint || started) return

  const headers = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const serviceName = env.OTEL_SERVICE_NAME ?? "ctxpipe-codesearch"
  const deploymentEnvironment = otelDeploymentEnvironment()

  const traceExporter = new OTLPTraceExporter({
    url: otlpSignalUrl(tracesEndpoint, "traces"),
    headers,
  })

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "service.namespace": "ctxpipe",
    "deployment.environment": deploymentEnvironment,
  })

  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BaggageAttributeSpanProcessor(),
      new BatchSpanProcessor(traceExporter),
    ],
  })
  // Registers W3C tracecontext + baggage and an AsyncLocalStorage context manager.
  tracerProvider.register()

  if (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) {
    metricReader = createMetricReader(
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      headers,
      isRailwayPrEnvironment(),
    )
    meterProvider = new MeterProvider({
      resource,
      readers: [metricReader],
    })
    metrics.setGlobalMeterProvider(meterProvider)
  }

  installOutgoingFetchInstrumentation()
  started = true
}

export function createMetricReader(
  metricsEndpoint: string,
  headers: Record<string, string>,
  prEnvironment: boolean,
): MetricReader {
  const exporter = new OTLPMetricExporter({
    url: otlpSignalUrl(metricsEndpoint, "metrics"),
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

function otlpSignalUrl(endpoint: string, signal: "traces" | "metrics"): string {
  const suffix = `/v1/${signal}`
  if (endpoint.endsWith(suffix)) return endpoint
  return `${endpoint.replace(/\/$/, "")}${suffix}`
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
 * Continue the caller's W3C trace and baggage, then record one server span.
 * PR environments flush after the response so metrics export without a 60s timer.
 */
export function codesearchOtelMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const carrier: Record<string, string> = {}
    const traceparent = c.req.header("traceparent")
    const tracestate = c.req.header("tracestate")
    const baggageHeader = c.req.header("baggage")
    if (traceparent) carrier.traceparent = traceparent
    if (tracestate) carrier.tracestate = tracestate
    if (baggageHeader) carrier.baggage = baggageHeader

    const parent = propagation.extract(context.active(), carrier)
    const tracer = trace.getTracer(TRACER_NAME)
    const span = tracer.startSpan(
      `${c.req.method} ${c.req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": c.req.method,
          "url.path": c.req.path,
          ...attributesFromBaggage(parent),
        },
      },
      parent,
    )

    try {
      await context.with(trace.setSpan(parent, span), async () => {
        await next()
      })
      const route = c.req.routePath
      if (route && !route.includes("*")) {
        span.updateName(`${c.req.method} ${route}`)
        span.setAttribute("http.route", route)
      }
      span.setAttribute("http.response.status_code", c.res.status)
      if (c.res.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      )
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
      if (isRailwayPrEnvironment()) {
        await forceFlushOtel()
      }
    }
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
        ...attributesFromBaggage(context.active()),
      },
    })
    return context.with(trace.setSpan(context.active(), span), async () => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      propagation.inject(context.active(), headers, {
        set(carrier, key, value) {
          carrier.set(key, value)
        },
      })
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

function isOtlpExportUrl(url: string): boolean {
  try {
    return /\/v1\/(traces|metrics|logs)\/?$/.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/**
 * Flush traces and metrics. PR HTTP/job paths call this after work so metrics
 * export without a 60s timer. Failures are swallowed (non-fatal, short timeout).
 */
export async function forceFlushOtel(): Promise<void> {
  if (!tracerProvider && !meterProvider) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([
        tracerProvider?.forceFlush() ?? Promise.resolve(),
        meterProvider?.forceFlush() ?? Promise.resolve(),
      ]),
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("otel forceFlush timeout")),
          FORCE_FLUSH_TIMEOUT_MS,
        )
      }),
    ])
  } catch {
    /* collector slow or unreachable — do not fail the request/job */
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Shutdown the OTEL SDK. Call on process exit.
 */
export async function shutdownOtel(): Promise<void> {
  const tracer = tracerProvider
  const meter = meterProvider
  tracerProvider = undefined
  meterProvider = undefined
  metricReader = undefined
  started = false
  await Promise.all([tracer?.shutdown(), meter?.shutdown()])
}
