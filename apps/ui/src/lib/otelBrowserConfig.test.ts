import { describe, expect, it } from "vitest"
import {
  OTEL_PROXY_MAX_BODY_BYTES,
  otelCollectorBaseUrl,
  otelProxyAdmission,
  otelProxySignalPath,
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
  it("forwards /.otel/v1/traces to the collector and drops the query", () => {
    expect(
      otelProxyUpstreamUrl(
        "http://c:4318",
        "https://app.example/.otel/v1/traces?x=1",
      ),
    ).toBe("http://c:4318/v1/traces")
  })

  it("does not invent a signal path for bare /.otel", () => {
    expect(
      otelProxyUpstreamUrl("http://c:4318", "https://app.example/.otel"),
    ).toBe("http://c:4318")
  })
})

describe("otelProxySignalPath", () => {
  it("keeps the OTLP signal suffix and drops a trailing slash", () => {
    expect(otelProxySignalPath("https://app.example/.otel/v1/logs/")).toBe(
      "/v1/logs",
    )
    expect(otelProxySignalPath("https://app.example/.otel")).toBe("")
  })
})

describe("otelProxyAdmission", () => {
  it("allows POST to traces and logs only", () => {
    for (const path of ["/v1/traces", "/v1/logs"]) {
      expect(
        otelProxyAdmission("POST", `https://app.example/.otel${path}`, 12),
      ).toEqual({ allow: true })
    }
    expect(
      otelProxyAdmission("POST", "https://app.example/.otel/v1/metrics", 12),
    ).toEqual({ allow: false, status: 404 })
  })

  it("404s unknown paths before method checks", () => {
    expect(
      otelProxyAdmission("GET", "https://app.example/.otel/v1/other", 0),
    ).toEqual({ allow: false, status: 404 })
    expect(otelProxyAdmission("POST", "https://app.example/.otel", 0)).toEqual({
      allow: false,
      status: 404,
    })
  })

  it("405s non-POST on an allowed path", () => {
    expect(
      otelProxyAdmission("GET", "https://app.example/.otel/v1/logs", 0),
    ).toEqual({ allow: false, status: 405 })
  })

  it("413s bodies over 1 MiB", () => {
    expect(
      otelProxyAdmission(
        "POST",
        "https://app.example/.otel/v1/logs",
        OTEL_PROXY_MAX_BODY_BYTES + 1,
      ),
    ).toEqual({ allow: false, status: 413 })
  })
})

describe("parseOtelHeaders", () => {
  it("parses ingest headers", () => {
    expect(parseOtelHeaders("authorization=secret")).toEqual({
      authorization: "secret",
    })
  })
})
