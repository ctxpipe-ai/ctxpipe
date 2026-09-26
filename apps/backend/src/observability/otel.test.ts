import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { contextWithAttributionBag } from "./attribution.js"
import {
  AttributionUrlSpanProcessor,
  DropParentlessInstrumentationSpans,
  isRailwayPrEnvironment,
  tracedOutgoingFetch,
} from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new AttributionUrlSpanProcessor(),
    new DropParentlessInstrumentationSpans(new SimpleSpanProcessor(exporter)),
  ],
})

beforeAll(() => {
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  )
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
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

describe("outgoing fetch spans", () => {
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

  it("skips a configured OTLP export URL", async () => {
    const previous = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "https://telemetry.ctxpipe.ai/v1/traces"
    const parent = trace.getTracer("test").startSpan("request")
    try {
      await context.with(trace.setSpan(context.active(), parent), async () => {
        await tracedOutgoingFetch(
          async () => new Response(null, { status: 200 }),
          "https://telemetry.ctxpipe.ai/v1/traces?timeout=1",
        )
        await tracedOutgoingFetch(
          async () => new Response(null, { status: 200 }),
          "https://example.com/v1/traces",
        )
      })
    } finally {
      parent.end()
      if (previous === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previous
    }
    const clients = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CLIENT)
    expect(clients.map((span) => span.attributes["url.full"])).toEqual([
      "https://example.com/v1/traces",
    ])
  })

  it("sends traceparent everywhere and baggage only to internal origins", async () => {
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
            ? input.href
            : input.url
      seen.push({
        url: raw,
        baggage: headers.get("baggage"),
        traceparent: headers.get("traceparent"),
      })
      return new Response(null, { status: 204 })
    }
    const parent = trace.getTracer("test").startSpan("request")
    const { context: withBag, bag } = contextWithAttributionBag(
      trace.setSpan(context.active(), parent),
    )
    bag.set("enduser.id", "user_1")
    bag.set("ctxpipe.org.id", "org_1")
    bag.set("ctxpipe.org.slug", "acme-corp")
    bag.set("ctxpipe.api_key.id", "key_1")
    bag.set("ctxpipe.conversation.id", "conv_1")
    try {
      await context.with(withBag, async () => {
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
        await tracedOutgoingFetch(capture, "http://[::1]:3001/health")
      })
    } finally {
      parent.end()
      if (previous === undefined) delete process.env.CODESEARCH_URL
      else process.env.CODESEARCH_URL = previous
    }

    const external = seen.find((entry) => entry.url.includes("api.openai.com"))
    expect(external?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(external?.baggage ?? "").not.toContain("enduser.id")
    expect(external?.baggage ?? "").not.toContain("acme-corp")

    for (const url of [
      "http://codesearch.internal:3001/search",
      "http://api.railway.internal:8080/health",
      "http://127.0.0.1:3001/health",
      "http://[::1]:3001/health",
    ]) {
      const internal = seen.find((entry) => entry.url === url)
      expect(internal?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      expect(internal?.baggage).toContain("enduser.id=user_1")
      expect(internal?.baggage).toContain("ctxpipe.org.slug=acme-corp")
    }

    const codesearchSpan = exporter
      .getFinishedSpans()
      .find(
        (span) =>
          span.attributes["url.full"] ===
          "http://codesearch.internal:3001/search",
      )
    expect(codesearchSpan?.instrumentationScope.name).toBe("ctxpipe-backend")
    expect(codesearchSpan?.name).toBe("HTTP GET")
    expect(codesearchSpan?.parentSpanContext?.spanId).toBe(
      parent.spanContext().spanId,
    )
    const spanContext = codesearchSpan?.spanContext()
    const codesearch = seen.find((entry) =>
      entry.url.includes("codesearch.internal"),
    )
    expect(codesearch?.traceparent).toBe(
      `00-${spanContext?.traceId}-${spanContext?.spanId}-01`,
    )
  })

  it("records a child client span without the query string", async () => {
    const parent = trace.getTracer("test").startSpan("request")
    await context.with(trace.setSpan(context.active(), parent), async () => {
      const response = await tracedOutgoingFetch(
        async () => new Response("ok", { status: 200 }),
        "https://user:pass@example.com/v1/files?token=SECRET#frag",
      )
      expect(response.status).toBe(200)
    })
    parent.end()
    const client = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.CLIENT)
    expect(client?.attributes["url.full"]).toBe("https://example.com/v1/files")
    expect(client?.attributes["url.path"]).toBe("/v1/files")
    expect(String(client?.attributes["url.full"])).not.toContain("?")
    expect(String(client?.attributes["url.path"])).not.toContain("?")
    expect(JSON.stringify(client?.attributes)).not.toContain("SECRET")
    expect(JSON.stringify(client?.attributes)).not.toContain("user:pass")
    expect(client?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
  })
})

describe("span URL attributes", () => {
  it("strips the query from url.full and url.path and redacts secret paths", () => {
    const token = "RVPATHPROBE1790327887NOTASECRET"
    const span = trace.getTracer("ctxpipe-backend").startSpan("GET /.auth", {
      kind: SpanKind.SERVER,
      attributes: {
        "url.full": `https://user:pass@example.com/.auth/reset-password/${token}?x=1#f`,
        "url.path": `/.auth/reset-password/${token}?x=1`,
      },
    })
    span.end()
    const finished = exporter
      .getFinishedSpans()
      .find((item) => item.name === "GET /.auth")
    expect(finished?.attributes["url.full"]).toBe(
      "https://example.com/.auth/reset-password/{token}",
    )
    expect(finished?.attributes["url.path"]).toBe(
      "/.auth/reset-password/{token}",
    )
    expect(String(finished?.attributes["url.full"])).not.toContain("?")
    expect(String(finished?.attributes["url.path"])).not.toContain("?")
    expect(JSON.stringify(finished?.attributes)).not.toContain(token)
  })
})

describe("parentless instrumentation spans", () => {
  it("drops a parentless auto-instrumentation span and keeps an error", () => {
    const redis = trace
      .getTracer("@opentelemetry/instrumentation-redis")
      .startSpan("redis-connect", { kind: SpanKind.CLIENT })
    redis.end()
    const failed = trace
      .getTracer("@opentelemetry/instrumentation-redis")
      .startSpan("redis-GET", { kind: SpanKind.CLIENT })
    failed.setStatus({ code: SpanStatusCode.ERROR })
    failed.end()
    const finished = exporter.getFinishedSpans()
    expect(finished.map((span) => span.name)).toEqual(["redis-GET"])
    expect(finished[0]?.status.code).toBe(SpanStatusCode.ERROR)
  })

  it("keeps a parented auto-instrumentation span and our own spans", () => {
    const job = trace
      .getTracer("ctxpipe-backend")
      .startSpan("openworkflow.job", { kind: SpanKind.CONSUMER })
    context.with(trace.setSpan(context.active(), job), () => {
      trace
        .getTracer("@opentelemetry/instrumentation-redis")
        .startSpan("redis-GET", { kind: SpanKind.CLIENT })
        .end()
    })
    job.end()
    const names = exporter.getFinishedSpans().map((span) => span.name)
    expect(names).toContain("openworkflow.job")
    expect(names).toContain("redis-GET")
  })
})
