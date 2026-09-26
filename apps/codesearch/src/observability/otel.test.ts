import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseEnv } from "../config/env.js"
import {
  codesearchResource,
  initOtel,
  isOtelStarted,
  otelMetricReader,
  shutdownOtel,
} from "./otel.js"

describe("codesearch resource", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("forces service.name codesearch and a deployment.environment", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("OTEL_SERVICE_NAME", "other")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    const attributes = codesearchResource().attributes
    expect(attributes["service.name"]).toBe("codesearch")
    expect(attributes["service.namespace"]).toBe("ctxpipe")
    expect(attributes["deployment.environment"]).toBe("production")
  })

  it("uses RAILWAY_ENVIRONMENT_NAME when resource attributes are unset", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-12")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    expect(codesearchResource().attributes["deployment.environment"]).toBe(
      "pr-12",
    )
  })

  it("lets OTEL_RESOURCE_ATTRIBUTES override deployment.environment", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-12")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=staging")
    const attributes = codesearchResource().attributes
    expect(attributes["deployment.environment"]).toBe("staging")
    expect(attributes["service.name"]).toBe("codesearch")
  })
})

describe("parseEnv otel endpoints", () => {
  it("accepts traces and metrics endpoints", () => {
    const env = parseEnv({
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
    })
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/traces",
    )
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/metrics",
    )
  })
})

describe("initOtel", () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    await shutdownOtel()
  })

  it("is a no-op without a traces endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")
    initOtel()
    expect(isOtelStarted()).toBe(false)
    expect(otelMetricReader()).toBeUndefined()
  })

  it("uses a periodic reader when metrics are configured", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production")
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://127.0.0.1:9/v1/traces",
    )
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "http://127.0.0.1:9/v1/metrics",
    )
    initOtel()
    expect(isOtelStarted()).toBe(true)
    expect(otelMetricReader()).toBeInstanceOf(PeriodicExportingMetricReader)
  })

  it("exports no metrics for Railway pr environments", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-4")
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://127.0.0.1:9/v1/traces",
    )
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "http://127.0.0.1:9/v1/metrics",
    )
    initOtel()
    expect(isOtelStarted()).toBe(true)
    expect(otelMetricReader()).toBeUndefined()
  })
})

describe("runtime metrics", () => {
  it("registers runtime-node instruments through the public API", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 60_000,
        }),
      ],
    })
    const runtime = new RuntimeNodeInstrumentation()
    runtime.setMeterProvider(provider)
    await provider.forceFlush()
    const names = exporter
      .getMetrics()
      .flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => metric.descriptor.name),
        ),
      )
    expect(names.some((name) => name.startsWith("nodejs.eventloop."))).toBe(
      true,
    )
    runtime.disable()
    await provider.shutdown()
  })
})
