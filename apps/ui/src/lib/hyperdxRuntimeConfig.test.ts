import { beforeEach, describe, expect, it } from "vitest"
import {
  getHyperDxRuntimeConfig,
  resetRetainedHyperDxRuntimeConfigForTests,
  retainServerHyperDxConfig,
} from "./hyperdxRuntimeConfig"

describe("getHyperDxRuntimeConfig", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.RAILWAY_ENVIRONMENT_NAME
    delete process.env.OTEL_BROWSER_OTLP_URL
    delete process.env.OTEL_BROWSER_API_KEY
    resetRetainedHyperDxRuntimeConfigForTests()
  })

  it("is disabled when no traces endpoint is set", () => {
    expect(getHyperDxRuntimeConfig()).toEqual({ enabled: false })
  })

  it("uses Railway's environment name and never a browser collector URL or key", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://collector:4318/v1/traces"
    process.env.RAILWAY_ENVIRONMENT_NAME = "pr-12"
    process.env.OTEL_BROWSER_OTLP_URL = "https://otel.example:4318"
    process.env.OTEL_BROWSER_API_KEY = "hdx_key"
    expect(getHyperDxRuntimeConfig()).toEqual({
      enabled: true,
      environment: "pr-12",
    })
  })

  it("omits deployment environment when Railway does not set one", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://collector:4318/v1/traces"
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    expect(getHyperDxRuntimeConfig()).toEqual({ enabled: true })
    process.env.NODE_ENV = previous
  })
})

describe("retainServerHyperDxConfig", () => {
  beforeEach(() => {
    resetRetainedHyperDxRuntimeConfigForTests()
  })

  it("keeps an enabled SSR config when a later client read is disabled", () => {
    const enabled = {
      enabled: true as const,
      environment: "pr-343",
    }
    expect(retainServerHyperDxConfig(enabled)).toEqual(enabled)
    expect(retainServerHyperDxConfig({ enabled: false })).toEqual(enabled)
  })
})
