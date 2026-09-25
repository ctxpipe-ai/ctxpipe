import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { context, metrics, propagation, trace } from "@opentelemetry/api"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
} from "@opentelemetry/sdk-metrics"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { FlushOnDemandMetricReader } from "./flushOnDemandMetricReader.js"
import {
  codesearchOtelMiddleware,
  installOutgoingFetchInstrumentation,
  tracedOutgoingFetch,
} from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

let downstreamPort = 0
let downstreamHeaders: { traceparent?: string; baggage?: string } = {}
let downstream: ReturnType<typeof createServer>

beforeAll(async () => {
  provider.register()
  installOutgoingFetchInstrumentation()
  downstream = createServer((req, res) => {
    const one = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value
    downstreamHeaders = {
      traceparent: one(req.headers.traceparent),
      baggage: one(req.headers.baggage),
    }
    res.writeHead(200)
    res.end("ok")
  })
  await new Promise<void>((resolve) => {
    downstream.listen(0, "127.0.0.1", resolve)
  })
  downstreamPort = (downstream.address() as AddressInfo).port
})

beforeEach(() => {
  exporter.reset()
  downstreamHeaders = {}
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    downstream.close((err) => (err ? reject(err) : resolve()))
  })
  await provider.shutdown()
})

describe("incoming W3C context", () => {
  it("joins the caller trace and keeps baggage on the request context", async () => {
    const app = new Hono()
    app.use("*", codesearchOtelMiddleware())
    app.get("/probe", (c) => {
      const baggage = propagation.getBaggage(context.active())
      return c.json({
        orgId: baggage?.getEntry("ctxpipe.org.id")?.value ?? null,
      })
    })

    const res = await app.request("http://codesearch.test/probe", {
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "ctxpipe.org.id=org_test",
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orgId: "org_test" })

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.name === "GET /probe")
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
    expect(span?.attributes["ctxpipe.org.id"]).toBe("org_test")
  })
})

describe("route template", () => {
  it("does not put repository ids in the span name or http.route", async () => {
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const meterProvider = new MeterProvider({
      readers: [new FlushOnDemandMetricReader(metricExporter)],
    })
    metrics.setGlobalMeterProvider(meterProvider)
    const app = new Hono()
    app.use("*", codesearchOtelMiddleware())
    app.use("*", async (c) => c.json({ error: "Unauthorized" }, 401))
    app.get("/repo_abc123/files", (c) => c.text("no"))

    const res = await app.request("http://codesearch.test/repo_abc123/files")
    expect(res.status).toBe(401)

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.attributes["url.path"] === "/repo_abc123/files")
    expect(span?.name.includes("repo_abc123")).toBe(false)
    expect(String(span?.attributes["http.route"]).includes("repo_abc123")).toBe(
      false,
    )

    await meterProvider.forceFlush()
    const duration = metricExporter
      .getMetrics()
      .flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.filter(
            (metric) =>
              metric.descriptor.name === "http.server.request.duration",
          ),
        ),
      )
    expect(duration.length).toBeGreaterThan(0)
    await meterProvider.shutdown()
  })
})

describe("outgoing fetch", () => {
  it("does not create a root span when nothing is tracing", async () => {
    const before = exporter.getFinishedSpans().length
    const res = await fetch(`http://127.0.0.1:${downstreamPort}/background`)
    expect(res.status).toBe(200)
    const added = exporter.getFinishedSpans().slice(before)
    expect(added.filter((span) => span.name.startsWith("HTTP"))).toHaveLength(0)
  })

  it("ends the client span when Request construction throws", async () => {
    const tracer = trace.getTracer("ctxpipe-codesearch-test")
    const parent = tracer.startSpan("caller")
    await expect(
      context.with(trace.setSpan(context.active(), parent), () =>
        fetch(`http://127.0.0.1:${downstreamPort}/down`, {
          method: "GET",
          body: "not-allowed-on-get",
        }),
      ),
    ).rejects.toThrow()
    parent.end()
    const client = exporter
      .getFinishedSpans()
      .find((item) => item.name === "HTTP GET")
    expect(client?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(client?.status.message ?? "").toBe("")
    expect(client?.events ?? []).toHaveLength(0)
  })

  it("does not copy a rejected response body onto the client span", async () => {
    const query = "ZQPROBE_file_paren_secret"
    const tracer = trace.getTracer("ctxpipe-codesearch-test")
    const parent = tracer.startSpan("caller")
    await context.with(trace.setSpan(context.active(), parent), async () => {
      const response = await tracedOutgoingFetch(
        async () => new Response(`parse error: ${query}`, { status: 400 }),
        "http://zoekt.test/api/search",
        { method: "POST", body: JSON.stringify({ Q: query }) },
      )
      expect(response.status).toBe(400)
    })
    parent.end()
    const client = exporter
      .getFinishedSpans()
      .find((item) => item.name === "HTTP POST")
    expect(client?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
    expect(client?.attributes["http.response.status_code"]).toBe(400)
    expect(client?.status.message ?? "").toBe("")
    expect(JSON.stringify(client?.events ?? [])).not.toContain(query)
    expect(JSON.stringify(client?.attributes)).not.toContain(query)
  })

  it("injects traceparent and baggage from the active context", async () => {
    const tracer = trace.getTracer("ctxpipe-codesearch-test")
    const parent = tracer.startSpan("caller")
    const withBaggage = propagation.setBaggage(
      trace.setSpan(context.active(), parent),
      propagation.createBaggage({
        "ctxpipe.org.id": { value: "org_from_backend" },
      }),
    )
    await context.with(withBaggage, async () => {
      const res = await fetch(`http://127.0.0.1:${downstreamPort}/down`)
      expect(res.status).toBe(200)
    })
    parent.end()

    expect(downstreamHeaders.traceparent).toContain(
      parent.spanContext().traceId,
    )
    expect(downstreamHeaders.baggage).toContain(
      "ctxpipe.org.id=org_from_backend",
    )
    const client = exporter
      .getFinishedSpans()
      .find((item) => item.name === "HTTP GET")
    expect(client?.spanContext().traceId).toBe(parent.spanContext().traceId)
    const token = "RVPATHPROBE1790327887NOTASECRET"
    await context.with(trace.setSpan(context.active(), parent), async () => {
      const res = await fetch(
        `http://127.0.0.1:${downstreamPort}/reset-password/${token}?token=${token}`,
      )
      expect(res.status).toBe(200)
    })
    const secretSpan = exporter
      .getFinishedSpans()
      .find(
        (item) =>
          String(item.attributes["url.full"] ?? "").includes(
            "reset-password",
          ) ||
          String(item.attributes["url.path"] ?? "").includes("reset-password"),
      )
    expect(JSON.stringify(secretSpan?.attributes)).not.toContain(token)
    expect(secretSpan?.attributes["url.path"]).toBe(`/reset-password/{token}`)
  })
})
