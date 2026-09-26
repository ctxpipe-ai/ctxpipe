import { metrics, ProxyTracerProvider, trace } from "@opentelemetry/api"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  codesearchDeploymentEnvironment,
  codesearchResource,
  initOtel,
  shutdownOtel,
} from "./otel.js"

function tracerIsRegistered(): boolean {
  const provider = trace.getTracerProvider()
  const delegate =
    provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider
  return delegate instanceof NodeTracerProvider
}

describe("codesearch resource", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("defaults service.name and deployment.environment when unset", () => {
    vi.stubEnv("OTEL_SERVICE_NAME", undefined)
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    const attributes = codesearchResource().attributes
    expect(attributes["service.name"]).toBe("codesearch")
    expect(attributes["service.namespace"]).toBe("ctxpipe")
    expect(attributes["deployment.environment"]).toBe("production")
    expect(codesearchDeploymentEnvironment()).toBe("production")
  })

  it("uses OTEL_SERVICE_NAME when a deploy sets it", () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "other")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    expect(codesearchResource().attributes["service.name"]).toBe("other")
  })

  it("prefers RAILWAY_ENVIRONMENT_NAME over resource attributes", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-12")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=staging")
    expect(codesearchDeploymentEnvironment()).toBe("pr-12")
    expect(codesearchResource().attributes["deployment.environment"]).toBe(
      "pr-12",
    )
  })

  it("reads deployment.environment from OTEL_RESOURCE_ATTRIBUTES when Railway is unset", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=staging")
    expect(codesearchDeploymentEnvironment()).toBe("staging")
    expect(codesearchResource().attributes["deployment.environment"]).toBe(
      "staging",
    )
  })

  it("uses the last percent-decoded deployment.environment entry", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "deployment.environment=first,service.name=ignored,deployment.environment=pr%2D7",
    )
    expect(codesearchDeploymentEnvironment()).toBe("pr-7")
    expect(codesearchResource().attributes["deployment.environment"]).toBe(
      "pr-7",
    )
  })

  it("uses development when Railway, resource attributes, and production are unset", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    expect(codesearchDeploymentEnvironment()).toBe("development")
  })
})

describe("initOtel", () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    try {
      await shutdownOtel()
    } finally {
      trace.disable()
      metrics.disable()
    }
  })

  it("does not start tracing or metrics without a traces endpoint", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")
    initOtel()
    expect(tracerIsRegistered()).toBe(false)
    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider)
  })

  it("installs a meter provider when metrics are configured", () => {
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
    expect(tracerIsRegistered()).toBe(true)
    expect(metrics.getMeterProvider()).toBeInstanceOf(MeterProvider)
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
    expect(tracerIsRegistered()).toBe(true)
    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider)
  })
})
