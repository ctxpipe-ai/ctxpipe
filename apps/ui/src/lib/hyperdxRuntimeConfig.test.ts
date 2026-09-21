import { beforeEach, describe, expect, it } from "vitest"
import { getHyperDxRuntimeConfig } from "./hyperdxRuntimeConfig"

describe("getHyperDxRuntimeConfig", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_BROWSER_OTLP_URL
    delete process.env.OTEL_BROWSER_API_KEY
    delete process.env.RAILWAY_ENVIRONMENT_NAME
  })

  it("is disabled when no traces endpoint is set", () => {
    expect(getHyperDxRuntimeConfig()).toEqual({ enabled: false })
  })

  it("uses the same-origin proxy when only the server OTLP endpoint is set", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://collector:4318/v1/traces"
    process.env.RAILWAY_ENVIRONMENT_NAME = "pr-12"
    expect(getHyperDxRuntimeConfig()).toEqual({
      enabled: true,
      url: "/.otel",
      environment: "pr-12",
    })
  })

  it("uses a public collector URL when OTEL_BROWSER_OTLP_URL is set", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "http://collector:4318/v1/traces"
    process.env.OTEL_BROWSER_OTLP_URL = "https://otel.example:4318"
    process.env.OTEL_BROWSER_API_KEY = "hdx_key"
    expect(getHyperDxRuntimeConfig()).toEqual({
      enabled: true,
      url: "https://otel.example:4318",
      environment: "test",
      apiKey: "hdx_key",
    })
  })
})
