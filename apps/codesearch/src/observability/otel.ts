import { metrics } from "@opentelemetry/api"
import { BaggageSpanProcessor } from "@opentelemetry/baggage-span-processor"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node"
import {
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources"
import {
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTRIBUTION_KEYS } from "./contract.js"

let tracerProvider: NodeTracerProvider | undefined
let meterProvider: MeterProvider | undefined
let metricReader: MetricReader | undefined
let runtimeInstrumentation: RuntimeNodeInstrumentation | undefined
let started = false

const URL_ATTRIBUTE_KEYS = [
  "url.full",
  "url.path",
  "http.url",
  "http.target",
] as const

/**
 * Railway sets `RAILWAY_ENVIRONMENT_NAME` (`production` or `pr-N`).
 * Local / unset falls back to NODE_ENV. `OTEL_RESOURCE_ATTRIBUTES` can
 * override this when merged in `codesearchResource`.
 */
export function codesearchDeploymentEnvironment(
  railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME,
  nodeEnv = process.env.NODE_ENV,
): string {
  const name = railwayEnvironmentName?.trim()
  if (name) return name
  return nodeEnv === "production" ? "production" : "development"
}

function railwayPrEnvironment(): boolean {
  return /^pr-\d+$/.test(process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ?? "")
}

/** Drop query strings and fragments from URL span attributes. */
class StripUrlQuerySpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    this.strip(span)
  }

  onEnding(span: Span): void {
    this.strip(span)
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  private strip(span: Span): void {
    for (const key of URL_ATTRIBUTE_KEYS) {
      const value = span.attributes[key]
      if (typeof value !== "string") continue
      const cut = value.search(/[?#]/)
      if (cut >= 0) span.setAttribute(key, value.slice(0, cut))
    }
  }
}

export function codesearchSpanProcessors(): SpanProcessor[] {
  return [
    new BaggageSpanProcessor((key) =>
      (ATTRIBUTION_KEYS as readonly string[]).includes(key),
    ),
    new StripUrlQuerySpanProcessor(),
  ]
}

export function codesearchResource() {
  return resourceFromAttributes({
    "service.name": "codesearch",
    "service.namespace": "ctxpipe",
    "deployment.environment": codesearchDeploymentEnvironment(),
  })
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(resourceFromAttributes({ "service.name": "codesearch" }))
}

export function isOtelStarted(): boolean {
  return started
}

/** Metric reader installed by the last `initOtel` call, if metrics export is on. */
export function otelMetricReader(): MetricReader | undefined {
  return metricReader
}

/**
 * Initialize tracing, and metrics outside Railway PR environments.
 * Exporters read the standard `OTEL_EXPORTER_OTLP_*` env vars.
 * PR (`pr-N`) exports traces only so the periodic metric timer does not
 * keep a preview replica awake.
 */
export function initOtel(): void {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!tracesEndpoint || started) return

  const resource = codesearchResource()
  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      ...codesearchSpanProcessors(),
      new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
  })
  tracerProvider.register()

  const metricsEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim()
  if (metricsEndpoint && !railwayPrEnvironment()) {
    metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 60_000,
    })
    meterProvider = new MeterProvider({
      resource,
      readers: [metricReader],
    })
    metrics.setGlobalMeterProvider(meterProvider)
    runtimeInstrumentation = new RuntimeNodeInstrumentation()
    runtimeInstrumentation.setMeterProvider(meterProvider)
  }

  started = true
}

export async function shutdownOtel(): Promise<void> {
  const tracer = tracerProvider
  const meter = meterProvider
  const runtime = runtimeInstrumentation
  tracerProvider = undefined
  meterProvider = undefined
  metricReader = undefined
  runtimeInstrumentation = undefined
  started = false
  runtime?.disable()
  await Promise.all([tracer?.shutdown(), meter?.shutdown()])
}
