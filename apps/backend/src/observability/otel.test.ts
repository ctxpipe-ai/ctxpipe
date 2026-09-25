import { context, SpanKind, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  isOtlpExportTarget,
  isRailwayPrEnvironment,
  isUiProxyFetchTarget,
  otelDeploymentEnvironment,
  parseOtelHeaders,
  sanitizedClientUrlAttributes,
  tracedOutgoingFetch,
} from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
})

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

describe("isOtlpExportTarget", () => {
  it("matches OTLP signal paths and ignores other URLs", () => {
    expect(isOtlpExportTarget("/v1/logs")).toBe(true)
    expect(isOtlpExportTarget("/v1/traces?timeout=1")).toBe(true)
    expect(isOtlpExportTarget("https://telemetry.ctxpipe.ai/v1/metrics")).toBe(
      true,
    )
    expect(isOtlpExportTarget("/search")).toBe(false)
    expect(isOtlpExportTarget(undefined)).toBe(false)
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

describe("outgoing fetch spans", () => {
  it("drops query, fragment, and userinfo from recorded urls", () => {
    expect(
      sanitizedClientUrlAttributes(
        "http://user:pass@example.com:8443/v1/files?token=SECRET#frag",
      ),
    ).toEqual({
      "url.scheme": "http",
      "server.address": "example.com",
      "url.path": "/v1/files",
      "url.full": "http://example.com:8443/v1/files",
    })
    expect(
      JSON.stringify(
        sanitizedClientUrlAttributes(
          "https://example.com/reset?token=SECRET#frag",
        ),
      ),
    ).not.toContain("SECRET")
  })

  it("does not create a root client span", async () => {
    const response = await tracedOutgoingFetch(
      async () => new Response(null, { status: 204 }),
      "https://example.com/reset?token=SECRET",
    )
    expect(response.status).toBe(204)
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.kind === SpanKind.CLIENT),
    ).toHaveLength(0)
  })

  it("skips the UI proxy even when a parent span is active", async () => {
    const previous = process.env.UI_PROXY_URL
    process.env.UI_PROXY_URL = "http://ui.railway.internal:3002"
    try {
      expect(
        isUiProxyFetchTarget(
          "http://ui.railway.internal:3002/.auth/reset-password?token=SECRET",
        ),
      ).toBe(true)
      const parent = trace.getTracer("test").startSpan("request")
      await context.with(trace.setSpan(context.active(), parent), async () => {
        await tracedOutgoingFetch(
          async () => new Response("page", { status: 200 }),
          "http://ui.railway.internal:3002/.auth/reset-password?token=SECRET",
        )
      })
      parent.end()
      expect(
        exporter
          .getFinishedSpans()
          .filter((span) => span.kind === SpanKind.CLIENT),
      ).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.UI_PROXY_URL
      else process.env.UI_PROXY_URL = previous
    }
  })

  it("records a child client span without the query string", async () => {
    const parent = trace.getTracer("test").startSpan("request")
    await context.with(trace.setSpan(context.active(), parent), async () => {
      const response = await tracedOutgoingFetch(
        async () => new Response("ok", { status: 200 }),
        "https://example.com/v1/files?token=SECRET#frag",
      )
      expect(response.status).toBe(200)
    })
    parent.end()
    const client = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.CLIENT)
    expect(client?.attributes["url.full"]).toBe("https://example.com/v1/files")
    expect(client?.attributes["url.path"]).toBe("/v1/files")
    expect(JSON.stringify(client?.attributes)).not.toContain("SECRET")
    expect(JSON.stringify(client?.attributes)).not.toContain("user:pass")
    expect(client?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  })
})
