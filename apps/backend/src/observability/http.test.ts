import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { backendOtelMiddleware } from "./http.js"

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

describe("backendOtelMiddleware", () => {
  it("continues traceparent, names the route, and returns x-request-id", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/orgs/:orgSlug/api/v1/repositories", (c) => c.json({ ok: true }))

    const res = await app.request(
      "http://backend.test/orgs/acme/api/v1/repositories",
      {
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-request-id": "req_kept",
          "user-agent": "ctxpipe-test",
        },
      },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("x-request-id")).toBe("req_kept")
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    expect(span?.name).toBe("GET /orgs/:orgSlug/api/v1/repositories")
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/orgs/:orgSlug/api/v1/repositories",
      "url.path": "/orgs/acme/api/v1/repositories",
      "http.response.status_code": 200,
      "request.id": "req_kept",
      "user_agent.original": "ctxpipe-test",
    })
    expect(trace.getActiveSpan()).toBeUndefined()
  })

  it("marks 5xx responses as errors and still returns x-request-id", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/boom", (c) => c.text("nope", 503))

    const res = await app.request("http://backend.test/boom")
    expect(res.status).toBe(503)
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    const span = exporter.getFinishedSpans().at(-1)
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.attributes["http.response.status_code"]).toBe(503)
  })

  it("does not create a span for proxied static assets", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/assets/app.js", (c) => c.text("js"))

    const res = await app.request("http://backend.test/assets/app.js", {
      headers: { "x-request-id": "asset_1" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("x-request-id")).toBe("asset_1")
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })
})
