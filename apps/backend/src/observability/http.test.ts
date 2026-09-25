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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { applyAttribution } from "./attribution.js"
import { backendOtelMiddleware, isUiProxyPath } from "./http.js"

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

describe("isUiProxyPath", () => {
  it("skips UI documents and assets and keeps API routes", () => {
    expect(isUiProxyPath("/assets/app.js")).toBe(true)
    expect(isUiProxyPath("/onboarding")).toBe(true)
    expect(isUiProxyPath("/mcp")).toBe(false)
    expect(isUiProxyPath("/.auth/api/session")).toBe(false)
  })
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

  it("redacts secret path segments on the server span", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
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

    const spans = exporter
      .getFinishedSpans()
      .filter((item) => item.kind === SpanKind.SERVER)
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

  it("records handler.end and response.ready on the server span", async () => {
    const app = new Hono()
    app.use("*", backendOtelMiddleware())
    app.get("/orgs/:orgSlug/api/v1/repositories", (c) => c.json({ ok: true }))

    const res = await app.request(
      "http://backend.test/orgs/acme/api/v1/repositories",
    )
    expect(res.status).toBe(200)
    const span = exporter
      .getFinishedSpans()
      .find((item) => item.kind === SpanKind.SERVER)
    const events = span?.events.map((event) => event.name)
    expect(events).toEqual(["handler.end", "response.ready"])
    const handlerEnd = span?.events[0]?.time
    const responseReady = span?.events[1]?.time
    expect(handlerEnd).toBeDefined()
    expect(responseReady).toBeDefined()
    if (!handlerEnd || !responseReady) return
    const toMs = (time: [number, number]) => time[0] * 1e3 + time[1] / 1e6
    expect(toMs(responseReady)).toBeGreaterThanOrEqual(toMs(handlerEnd))
  })

  it("schedules the PR otel flush only after the server span has ended", async () => {
    const previous = process.env.RAILWAY_ENVIRONMENT_NAME
    process.env.RAILWAY_ENVIRONMENT_NAME = "pr-343"
    const original = globalThis.setTimeout
    const spanEndedBeforeFlush: boolean[] = []
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof fn === "function" &&
        delay === 0 &&
        String(fn).includes("forceFlushOtel")
      ) {
        spanEndedBeforeFlush.push(
          exporter
            .getFinishedSpans()
            .some((span) => span.kind === SpanKind.SERVER),
        )
      }
      return original(fn as never, delay as never, ...(args as []))
    }) as unknown as typeof setTimeout)
    try {
      const app = new Hono()
      app.use("*", backendOtelMiddleware())
      app.get("/.status", (c) => c.text("ok"))
      const res = await app.request("http://backend.test/.status")
      expect(res.status).toBe(200)
      expect(spanEndedBeforeFlush).toEqual([true])
    } finally {
      spy.mockRestore()
      if (previous === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME
      else process.env.RAILWAY_ENVIRONMENT_NAME = previous
    }
  })

  it("does not schedule an otel flush outside PR environments", async () => {
    const previous = process.env.RAILWAY_ENVIRONMENT_NAME
    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    const original = globalThis.setTimeout
    let scheduled = 0
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof fn === "function" &&
        delay === 0 &&
        String(fn).includes("forceFlushOtel")
      ) {
        scheduled += 1
      }
      return original(fn as never, delay as never, ...(args as []))
    }) as unknown as typeof setTimeout)
    try {
      const app = new Hono()
      app.use("*", backendOtelMiddleware())
      app.get("/.status", (c) => c.text("ok"))
      const res = await app.request("http://backend.test/.status")
      expect(res.status).toBe(200)
      expect(scheduled).toBe(0)
    } finally {
      spy.mockRestore()
      if (previous === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME
      else process.env.RAILWAY_ENVIRONMENT_NAME = previous
    }
  })
})
