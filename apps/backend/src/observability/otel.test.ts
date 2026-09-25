import { context, SpanKind, trace } from "@opentelemetry/api"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  applyAttribution,
  contextWithAttributionBag,
} from "./attribution.js"
import {
  isOtlpExportTarget,
  isRailwayPrEnvironment,
  isUiProxyFetchTarget,
  nodeAutoInstrumentationConfig,
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

describe("nodeAutoInstrumentationConfig", () => {
  it("leaves Postgres spans to dbTrace and omits instrumentation-pg", () => {
    const config = nodeAutoInstrumentationConfig()
    expect(config["@opentelemetry/instrumentation-pg"]).toEqual({
      enabled: false,
    })
    const instrumentations = getNodeAutoInstrumentations(config)
    expect(
      instrumentations.some(
        (instrumentation) =>
          instrumentation.instrumentationName ===
          "@opentelemetry/instrumentation-pg",
      ),
    ).toBe(false)
    expect(
      instrumentations.some(
        (instrumentation) =>
          instrumentation.instrumentationName ===
          "@opentelemetry/instrumentation-http",
      ),
    ).toBe(true)
  })
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
  const keys = [
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ] as const
  const previous: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of keys) previous[key] = process.env[key]
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "https://telemetry.ctxpipe.ai/v1/traces"
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
      "https://telemetry.ctxpipe.ai"
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      "https://telemetry.ctxpipe.ai/v1/logs"
  })

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })

  it("matches only the configured exporter endpoints", () => {
    expect(isOtlpExportTarget("https://telemetry.ctxpipe.ai/v1/traces")).toBe(
      true,
    )
    expect(
      isOtlpExportTarget("https://telemetry.ctxpipe.ai/v1/traces?timeout=1"),
    ).toBe(true)
    expect(isOtlpExportTarget("https://telemetry.ctxpipe.ai/v1/metrics")).toBe(
      true,
    )
    expect(isOtlpExportTarget("https://telemetry.ctxpipe.ai/v1/logs")).toBe(
      true,
    )
    expect(isOtlpExportTarget("https://example.com/v1/traces")).toBe(false)
    expect(isOtlpExportTarget("https://logs.other.test/v1/logs")).toBe(false)
    expect(isOtlpExportTarget("/v1/logs")).toBe(false)
    expect(isOtlpExportTarget("https://telemetry.ctxpipe.ai/search")).toBe(
      false,
    )
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
    const token = "RVPATHPROBE1790327887NOTASECRET"
    const invitationId = "inv_secret_capability"
    const reset = sanitizedClientUrlAttributes(
      `https://user:pass@example.com/.auth/api/v1/auth/reset-password/${token}?callbackURL=https://app.example/reset`,
    )
    const invitation = sanitizedClientUrlAttributes(
      `https://example.com/.auth/api/v1/public/invitations/${invitationId}`,
    )
    expect(reset["url.path"]).toBe("/.auth/api/v1/auth/reset-password/{token}")
    expect(reset["url.full"]).toBe(
      "https://example.com/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(invitation["url.path"]).toBe(
      "/.auth/api/v1/public/invitations/{invitation}",
    )
    expect(JSON.stringify({ reset, invitation })).not.toContain(token)
    expect(JSON.stringify({ reset, invitation })).not.toContain(invitationId)
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

  it("sends attribution baggage only to internal services", async () => {
    const previous = process.env.CODESEARCH_URL
    process.env.CODESEARCH_URL = "http://codesearch.internal:3001"
    const seen: {
      url: string
      baggage: string | null
      traceparent: string | null
    }[] = []
    const capture = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      )
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      seen.push({
        url: raw,
        baggage: headers.get("baggage"),
        traceparent: headers.get("traceparent"),
      })
      return new Response(null, { status: 204 })
    }
    const parent = trace.getTracer("test").startSpan("request")
    const { context: withBag } = contextWithAttributionBag(
      trace.setSpan(context.active(), parent),
    )
    try {
      await context.with(withBag, async () => {
        applyAttribution({
          "enduser.id": "user_1",
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme-corp",
          "ctxpipe.api_key.id": "key_1",
          "ctxpipe.conversation.id": "conv_1",
        })
        await tracedOutgoingFetch(
          capture,
          "https://api.openai.com/v1/chat/completions",
          { method: "POST" },
        )
        await tracedOutgoingFetch(
          capture,
          "http://codesearch.internal:3001/search",
        )
        await tracedOutgoingFetch(
          capture,
          "http://api.railway.internal:8080/health",
        )
        await tracedOutgoingFetch(capture, "http://127.0.0.1:3001/health")
      })
    } finally {
      parent.end()
      if (previous === undefined) delete process.env.CODESEARCH_URL
      else process.env.CODESEARCH_URL = previous
    }

    const external = seen.find((entry) => entry.url.includes("api.openai.com"))
    expect(external?.traceparent).toContain(parent.spanContext().traceId)
    expect(external?.baggage ?? "").not.toContain("enduser.id")
    expect(external?.baggage ?? "").not.toContain("acme-corp")
    expect(external?.baggage ?? "").not.toContain("key_1")
    expect(external?.baggage ?? "").not.toContain("conv_1")

    for (const url of [
      "http://codesearch.internal:3001/search",
      "http://api.railway.internal:8080/health",
      "http://127.0.0.1:3001/health",
    ]) {
      const internal = seen.find((entry) => entry.url === url)
      expect(internal?.traceparent).toContain(parent.spanContext().traceId)
      expect(internal?.baggage).toContain("enduser.id=user_1")
      expect(internal?.baggage).toContain("ctxpipe.org.slug=acme-corp")
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
