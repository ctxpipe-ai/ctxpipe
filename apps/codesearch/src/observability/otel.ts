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
let runtimeInstrumentation: RuntimeNodeInstrumentation | undefined
let started = false

/**
 * `RAILWAY_ENVIRONMENT_NAME` if set, else `deployment.environment` from
 * `OTEL_RESOURCE_ATTRIBUTES`, else `production` when NODE_ENV is production,
 * else `development`.
 */
export function codesearchDeploymentEnvironment(
  railwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME,
  resourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES,
  nodeEnv = process.env.NODE_ENV,
): string {
  const railway = railwayEnvironmentName?.trim()
  if (railway) return railway
  const fromAttributes = deploymentEnvironmentAttribute(resourceAttributes)
  if (fromAttributes) return fromAttributes
  return nodeEnv === "production" ? "production" : "development"
}

/** Last `deployment.environment` entry, percent-decoded. Same rule as envDetector. */
function deploymentEnvironmentAttribute(
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined
  let found: string | undefined
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    if (entry.slice(0, eq).trim() !== "deployment.environment") continue
    const value = entry.slice(eq + 1).trim()
    if (!value) continue
    try {
      found = decodeURIComponent(value)
    } catch {
      found = value
    }
  }
  return found
}

function railwayPrEnvironment(): boolean {
  return /^pr-\d+$/.test(process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ?? "")
}

/** `@hono/otel` sets `url.full` when the span starts. Drop its query and fragment. */
class StripUrlQuerySpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const value = span.attributes["url.full"]
    if (typeof value !== "string") return
    const cut = value.search(/[?#]/)
    if (cut >= 0) span.setAttribute("url.full", value.slice(0, cut))
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
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
  })
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        "deployment.environment": codesearchDeploymentEnvironment(),
      }),
    )
}

/** `service.name` after env detection, so logs match traces (`OTEL_SERVICE_NAME`). */
export function codesearchServiceName(): string {
  const name = codesearchResource().attributes["service.name"]
  return typeof name === "string" && name.length > 0 ? name : "codesearch"
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
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 60_000,
        }),
      ],
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
  runtimeInstrumentation = undefined
  started = false
  runtime?.disable()
  await Promise.all([tracer?.shutdown(), meter?.shutdown()])
}
