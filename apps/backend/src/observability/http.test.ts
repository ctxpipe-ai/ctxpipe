import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { type EvlogVariables, evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { applyAttribution, propagationHeaders } from "./attribution.js"
import { backendOtelMiddleware } from "./http.js"
import { AttributionUrlSpanProcessor } from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new AttributionUrlSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
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

function createApp(): Hono<EvlogVariables> {
  const app = new Hono<EvlogVariables>()
  app.use(contextStorage())
  app.use("*", backendOtelMiddleware())
  app.use(evlog())
  return app
}

function serverSpans() {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.kind === SpanKind.SERVER)
}

describe("backendOtelMiddleware", () => {
  it("continues traceparent, names the route, and returns one x-request-id", async () => {
    const app = createApp()
    app.get("/orgs/:orgSlug/api/v1/repositories", (c) => {
      const requestId = c.get("log").getContext().requestId
      return c.json({ requestId })
    })

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
    expect(await res.json()).toEqual({ requestId: "req_kept" })
    const span = serverSpans()[0]
    expect(span?.name).toBe("GET /orgs/:orgSlug/api/v1/repositories")
    expect(span?.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(span?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
    expect(span?.attributes).toMatchObject({
      "http.request.method": "GET",
      "http.route": "/orgs/:orgSlug/api/v1/repositories",
      "url.path": "/orgs/acme/api/v1/repositories",
      "url.full": "http://backend.test/orgs/acme/api/v1/repositories",
      "http.response.status_code": 200,
      "request.id": "req_kept",
      "user_agent.original": "ctxpipe-test",
    })
    expect(trace.getActiveSpan()).toBeUndefined()
  })

  it("replaces an unsafe x-request-id once for the span and the log", async () => {
    const app = createApp()
    app.get("/.status", (c) =>
      c.json({ requestId: c.get("log").getContext().requestId }),
    )

    const res = await app.request("http://backend.test/.status", {
      headers: { "x-request-id": "has spaces" },
    })
    const body = (await res.json()) as { requestId: string }
    expect(res.headers.get("x-request-id")).toBe(body.requestId)
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(serverSpans()[0]?.attributes["request.id"]).toBe(body.requestId)
  })

  it("marks 5xx responses as errors and still returns x-request-id", async () => {
    const app = createApp()
    app.get("/.status", (c) => c.text("nope", 503))

    const res = await app.request("http://backend.test/.status")
    expect(res.status).toBe(503)
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    const span = serverSpans().at(-1)
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.attributes["http.response.status_code"]).toBe(503)
  })

  it("does not create a span for the UI catch-all and does for a new route", async () => {
    const app = createApp()
    app.get("/future-product-route", (c) => c.text("new"))
    app.all("/.otel/v1/:signal", (c) => c.text("otel"))
    app.all("*", (c) => c.text("page"))

    for (const path of [
      "/assets/app.js",
      "/onboarding",
      "/obs-e2e-343/knowledge-graph",
    ]) {
      const res = await app.request(`http://backend.test${path}`, {
        headers: { "x-request-id": "asset_1" },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("page")
      expect(res.headers.get("x-request-id")).toBe("asset_1")
    }
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    const created = await app.request(
      "http://backend.test/future-product-route",
    )
    expect(created.status).toBe(200)
    expect(serverSpans().map((span) => span.name)).toEqual([
      "GET /future-product-route",
    ])
  })

  it("strips the query string from url attributes", async () => {
    const app = createApp()
    app.get("/.status", (c) => c.text("ok"))

    const secret = "query-token-not-a-secret"
    await app.request(`http://backend.test/.status?token=${secret}`)
    const span = serverSpans()[0]
    expect(String(span?.attributes["url.full"])).not.toContain("?")
    expect(String(span?.attributes["url.path"])).not.toContain("?")
    expect(JSON.stringify(span?.attributes)).not.toContain(secret)
  })

  it("sets http.route to the template for wildcard routes", async () => {
    const app = createApp()
    app.all("/.auth/api/*", (c) => c.json({ ok: true }))

    const res = await app.request(
      "http://backend.test/.auth/api/v1/auth/get-session",
    )
    expect(res.status).toBe(200)
    const span = serverSpans()[0]
    expect(span?.name).toBe("GET /.auth/api/*")
    expect(span?.attributes["http.route"]).toBe("/.auth/api/*")
    expect(span?.attributes["url.path"]).toBe("/.auth/api/v1/auth/get-session")
  })

  it("redacts secret path segments on the server span", async () => {
    const app = createApp()
    app.all("/.auth/api/*", (c) => c.json({ ok: true }))
    app.get("/.auth/api/v1/public/invitations/:invitationId", (c) =>
      c.json({ ok: true }),
    )

    const token = "RVPATHPROBE1790327887NOTASECRET"
    const invitationId = "inv_secret_capability"
    await app.request(
      `http://backend.test/.auth/api/v1/auth/reset-password/${token}`,
    )
    await app.request(
      `http://backend.test/.auth/api/v1/public/invitations/${invitationId}`,
    )

    const spans = serverSpans()
    const reset = spans.find((span) =>
      String(span.attributes["url.path"]).includes("reset-password"),
    )
    const invitation = spans.find((span) =>
      String(span.attributes["url.path"]).includes("invitations"),
    )
    expect(reset?.attributes["url.path"]).toBe(
      "/.auth/api/v1/auth/reset-password/{token}",
    )
    expect(invitation?.attributes["url.path"]).toBe(
      "/.auth/api/v1/public/invitations/{invitation}",
    )
    const serialized = JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
      })),
    )
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(invitationId)
  })

  it("names mcp and the registered otel relay from the route", async () => {
    const app = createApp()
    app.post("/mcp", (c) => c.json({ ok: true }))
    app.all("/.otel/v1/:signal", (c) => c.text(c.req.path))
    app.all("*", (c) => c.text("ui"))

    await app.request("http://backend.test/mcp", { method: "POST" })
    const traces = await app.request("http://backend.test/.otel/v1/traces", {
      method: "POST",
    })
    const logs = await app.request("http://backend.test/.otel/v1/logs", {
      method: "POST",
    })
    expect(await traces.text()).toBe("/.otel/v1/traces")
    expect(await logs.text()).toBe("/.otel/v1/logs")
    const spans = serverSpans()
    expect(spans.map((span) => span.name)).toEqual([
      "POST /mcp",
      "POST /.otel/v1/:signal",
      "POST /.otel/v1/:signal",
    ])
    expect(spans.map((span) => span.attributes["http.route"])).toEqual([
      "/mcp",
      "/.otel/v1/:signal",
      "/.otel/v1/:signal",
    ])
    expect(spans.map((span) => span.attributes["url.path"])).toEqual([
      "/mcp",
      "/.otel/v1/traces",
      "/.otel/v1/logs",
    ])
  })

  it("ignores spoofed attribution baggage on an unauthenticated request", async () => {
    const app = createApp()
    app.get("/.auth/api/config", (c) => {
      const headers = new Headers()
      propagationHeaders(headers)
      return c.json({ baggage: headers.get("baggage") })
    })

    const res = await app.request("http://backend.test/.auth/api/config", {
      headers: {
        baggage:
          "enduser.id=user_SPOOFED_BY_REVIEW,ctxpipe.org.id=org_SPOOFED,ctxpipe.actor.type=job",
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { baggage: string | null }
    expect(body.baggage ?? "").not.toContain("SPOOFED")
    expect(body.baggage ?? "").not.toContain("ctxpipe.actor.type=job")
    const span = serverSpans()[0]
    expect(span?.attributes["enduser.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.org.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.actor.type"]).toBeUndefined()
    expect(span?.attributes["request.id"]).toEqual(expect.any(String))
    expect(body.baggage).toContain(
      `request.id=${span?.attributes["request.id"]}`,
    )
  })

  it("does not let spoofed repository or conversation baggage win over auth", async () => {
    const app = createApp()
    app.get("/orgs/:orgSlug/api/v1/repositories", (c) => {
      applyAttribution({
        "enduser.id": "user_real",
        "ctxpipe.org.id": "org_real",
        "ctxpipe.actor.type": "user",
      })
      const headers = new Headers()
      propagationHeaders(headers)
      return c.json({ baggage: headers.get("baggage") })
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
    const body = (await res.json()) as { baggage: string }
    expect(body.baggage).not.toContain("SPOOFED")
    const span = serverSpans()[0]
    expect(span?.attributes).toMatchObject({
      "enduser.id": "user_real",
      "ctxpipe.org.id": "org_real",
      "ctxpipe.actor.type": "user",
    })
    expect(span?.attributes["ctxpipe.repository.id"]).toBeUndefined()
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
  })

  it("leaves the server span active while evlog enriches the log", async () => {
    let enrichTraceId: string | undefined
    const app = new Hono<EvlogVariables>()
    app.use(contextStorage())
    app.use("*", backendOtelMiddleware())
    app.use(
      evlog({
        enrich: () => {
          enrichTraceId = trace.getActiveSpan()?.spanContext().traceId
        },
      }),
    )
    app.get("/.status", (c) => c.text("ok"))

    const res = await app.request("http://backend.test/.status")
    expect(res.status).toBe(200)
    expect(enrichTraceId).toBe(serverSpans()[0]?.spanContext().traceId)
  })
})
