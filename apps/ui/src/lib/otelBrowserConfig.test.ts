import { describe, expect, it } from "vitest"
import {
  otelCollectorBaseUrl,
  otelProxyUpstreamUrl,
  parseOtelHeaders,
} from "./otelBrowserConfig"

describe("otelCollectorBaseUrl", () => {
  it("strips signal suffixes", () => {
    expect(otelCollectorBaseUrl("http://c:4318/v1/traces")).toBe(
      "http://c:4318",
    )
    expect(otelCollectorBaseUrl("http://c:4318/v1/logs/")).toBe("http://c:4318")
    expect(otelCollectorBaseUrl("http://c:4318")).toBe("http://c:4318")
  })
})

describe("otelProxyUpstreamUrl", () => {
  it("forwards /.otel/v1/traces to the collector", () => {
    expect(
      otelProxyUpstreamUrl(
        "http://c:4318",
        "https://app.example/.otel/v1/traces",
      ),
    ).toBe("http://c:4318/v1/traces")
  })

  it("defaults the collector root to /v1/traces", () => {
    expect(
      otelProxyUpstreamUrl("http://c:4318", "https://app.example/.otel"),
    ).toBe("http://c:4318/v1/traces")
  })
})

describe("parseOtelHeaders", () => {
  it("parses ingest headers", () => {
    expect(parseOtelHeaders("authorization=secret")).toEqual({
      authorization: "secret",
    })
  })
})
