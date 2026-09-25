import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { describe, expect, it } from "vitest"
import {
  isRailwayPrEnvironment,
  otelDeploymentEnvironment,
  parseOtelHeaders,
} from "./otel.js"

describe("otelDeploymentEnvironment", () => {
  it("uses RAILWAY_ENVIRONMENT_NAME when set", () => {
    expect(otelDeploymentEnvironment("pr-12", "production")).toBe("pr-12")
    expect(otelDeploymentEnvironment("production", "development")).toBe(
      "production",
    )
  })

  it("falls back to NODE_ENV", () => {
    expect(otelDeploymentEnvironment("", "production")).toBe("production")
    expect(otelDeploymentEnvironment(undefined, "development")).toBe(
      "development",
    )
  })
})

describe("isRailwayPrEnvironment", () => {
  it("matches Railway preview names only", () => {
    expect(isRailwayPrEnvironment("pr-1")).toBe(true)
    expect(isRailwayPrEnvironment("pr-334")).toBe(true)
    expect(isRailwayPrEnvironment("production")).toBe(false)
    expect(isRailwayPrEnvironment("pr-env")).toBe(false)
    expect(isRailwayPrEnvironment("")).toBe(false)
  })
})

describe("runtime-node instrumentation", () => {
  it("is included by default and stays enabled when asked explicitly", () => {
    const defaults = getNodeAutoInstrumentations()
    const explicit = getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-runtime-node": { enabled: true },
    })
    const enabled = (items: ReturnType<typeof getNodeAutoInstrumentations>) =>
      items.find(
        (item) =>
          item.instrumentationName ===
          "@opentelemetry/instrumentation-runtime-node",
      )
    expect(enabled(defaults)?.getConfig().enabled ?? true).toBe(true)
    expect(enabled(explicit)?.getConfig().enabled).toBe(true)
    for (const item of [...defaults, ...explicit]) item.disable()
  })
})

describe("parseOtelHeaders", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseOtelHeaders("authorization=abc,x-foo=bar")).toEqual({
      authorization: "abc",
      "x-foo": "bar",
    })
  })

  it("returns empty object when unset", () => {
    expect(parseOtelHeaders(undefined)).toEqual({})
    expect(parseOtelHeaders("")).toEqual({})
  })
})
