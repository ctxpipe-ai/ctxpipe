import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { Hono } from "hono"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { applyAttribution } from "./attribution.js"
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
    app.get("/.status", (c) => c.text("nope", 503))

    const res = await app.request("http://backend.test/.status")
    expect(res.status).toBe(503)
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    const span = exporter.getFinishedSpans().at(-1)
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.attributes["http.response.status_code"]).toBe(503)
  })

  it("does not create a span for proxied static assets or SPA documents", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/assets/app.js", (c) => c.text("js"))
    app.get("/onboarding", (c) => c.text("page"))
    app.get("/obs-e2e-343/knowledge-graph", (c) => c.text("page"))

    for (const path of [
      "/assets/app.js",
      "/onboarding",
      "/obs-e2e-343/knowledge-graph",
    ]) {
      const res = await app.request(`http://backend.test${path}`, {
        headers: { "x-request-id": "asset_1" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-request-id")).toBe("asset_1")
    }
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it("sets http.route to the template for wildcard routes", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.all("/.auth/api/*", (c) => c.json({ ok: true }))

    const res = await app.request(
      "http://backend.test/.auth/api/v1/auth/get-session",
    )
    expect(res.status).toBe(200)
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    expect(span?.name).toBe("GET /.auth/api/*")
    expect(span?.attributes["http.route"]).toBe("/.auth/api/*")
    expect(span?.attributes["url.path"]).toBe("/.auth/api/v1/auth/get-session")
  })

  it("keeps spans for mcp and the otel proxy", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.post("/mcp", (c) => c.json({ ok: true }))
    app.post("/.otel/v1/traces", (c) => c.json({ ok: true }))

    await app.request("http://backend.test/mcp", { method: "POST" })
    await app.request("http://backend.test/.otel/v1/traces", { method: "POST" })
    const names = exporter.getFinishedSpans().map((span) => span.name)
    expect(names).toEqual(["POST /mcp", "POST /.otel/v1/traces"])
    expect(
      exporter.getFinishedSpans().map((span) => span.attributes["http.route"]),
    ).toEqual(["/mcp", "/.otel/v1/traces"])
  })

  it("ignores spoofed attribution baggage on an unauthenticated request", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/.auth/api/config", (c) => {
      const baggage = propagation.getBaggage(context.active())
      return c.json({
        enduser: baggage?.getEntry("enduser.id")?.value ?? null,
        org: baggage?.getEntry("ctxpipe.org.id")?.value ?? null,
        actor: baggage?.getEntry("ctxpipe.actor.type")?.value ?? null,
      })
    })

    const res = await app.request("http://backend.test/.auth/api/config", {
      headers: {
        baggage:
          "enduser.id=user_SPOOFED_BY_REVIEW,ctxpipe.org.id=org_SPOOFED,ctxpipe.actor.type=job",
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enduser: null,
      org: null,
      actor: null,
    })
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    expect(span?.attributes["enduser.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.org.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.actor.type"]).toBeUndefined()
    expect(span?.attributes["request.id"]).toEqual(expect.any(String))
  })

  it("does not let spoofed repository or conversation baggage win over auth", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/orgs/:orgSlug/api/v1/repositories", (c) => {
      applyAttribution({
        "enduser.id": "user_real",
        "ctxpipe.org.id": "org_real",
        "ctxpipe.actor.type": "user",
      })
      return c.json({ ok: true })
    })

    const res = await app.request(
      "http://backend.test/orgs/acme/api/v1/repositories",
      {
        headers: {
          baggage:
            "ctxpipe.repository.id=repo_SPOOFED,ctxpipe.conversation.id=thr_SPOOFED,enduser.id=user_SPOOFED_BY_REVIEW",
        },
      },
    )
    expect(res.status).toBe(200)
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    expect(span?.attributes).toMatchObject({
      "enduser.id": "user_real",
      "ctxpipe.org.id": "org_real",
      "ctxpipe.actor.type": "user",
    })
    expect(span?.attributes["ctxpipe.repository.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
  })
})
