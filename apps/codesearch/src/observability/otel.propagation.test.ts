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
  })
})
