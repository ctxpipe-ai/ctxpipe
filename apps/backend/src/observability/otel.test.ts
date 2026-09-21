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
