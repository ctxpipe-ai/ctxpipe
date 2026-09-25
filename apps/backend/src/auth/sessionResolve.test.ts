import { SpanKind, trace } from "@opentelemetry/api"
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
import type { AppEnv } from "../app/env.js"

const { getSessionMock, authHandlerMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  authHandlerMock: vi.fn(),
}))

vi.mock("./config.js", () => ({
  getAuth: () => ({
    api: { getSession: getSessionMock },
    handler: authHandlerMock,
    options: { socialProviders: {} },
  }),
}))

vi.mock("../db/client.js", () => ({
  getSystemDb: vi.fn(),
  withOrgDbContext: vi.fn(),
}))

vi.mock("../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
  }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { backendOtelMiddleware } from "../observability/http.js"
import { registerAuthRoutes } from "../routes/auth.js"
import { withSharedCookieSession } from "./withAuth.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

const sessionToken = "session-token-must-stay-off-the-span"
const sessionEmail = "ada@example.com"

function startBetterAuthChild(name: string): void {
  const child = trace.getTracer("better-auth").startSpan(name)
  child.end()
}

function bindRequestContext(app: Hono<AppEnv>): void {
  app.use("*", async (c, next) => {
    c.set("env", {
      AUTH_BASE_URL: "https://backend.example.com",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      UI_PROXY_URL: "http://ui:3002",
      NODE_ENV: "test",
      PORT: 3000,
      GRAPH_DB_URI: "redis://localhost:6379",
      GRAPH_DB_PROVIDER: "falkordb",
    } as AppEnv["Variables"]["env"])
    c.set("user", null)
    c.set("session", null)
    c.set("oauthOrganizationId", null)
    c.set("orgApiKey", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
}

function createTracedSessionApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", backendOtelMiddleware())
  bindRequestContext(app)
  app.use("*", withSharedCookieSession)
  app.get("/assets/app.js", (c) => c.text("js"))
  app.get("/", (c) => c.text("spa"))
  app.get("/.auth/sign-in", (c) => c.text("sign-in"))
  app.get("/obs-e2e/knowledge-graph", (c) => c.text("graph"))
  app.post("/.otel/v1/traces", (c) => c.text("otel"))
  app.get("/acme/api/v1/repositories", (c) =>
    c.json({ id: c.get("user")?.id ?? null }),
  )
  return app
}

function createAuthApp(traced: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  if (traced) app.use("*", backendOtelMiddleware())
  bindRequestContext(app)
  if (traced) app.use("*", withSharedCookieSession)
  registerAuthRoutes(app)
  return app
}

function sessionResponse(activeOrganizationId?: string): Response {
  return new Response(
    JSON.stringify({
      session: {
        id: "sess_1",
        userId: "user_1",
        token: sessionToken,
        ...(activeOrganizationId ? { activeOrganizationId } : {}),
      },
      user: { id: "user_1", email: sessionEmail, name: "Ada" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue(null)
  authHandlerMock.mockReset()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("shared cookie session spans", () => {
  it("does not read the session or start a span for UI proxy paths", async () => {
    getSessionMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return null
    })
    const app = createTracedSessionApp()
    for (const path of [
      "/assets/app.js",
      "/",
      "/.auth/sign-in",
      "/obs-e2e/knowledge-graph",
    ]) {
      const response = await app.request(`http://backend.test${path}`)
      expect(response.status).toBe(200)
    }
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it("does not read the session for /.otel", async () => {
    getSessionMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return null
    })
    const app = createTracedSessionApp()
    const response = await app.request("http://backend.test/.otel/v1/traces", {
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(getSessionMock).not.toHaveBeenCalled()
    const spans = exporter.getFinishedSpans()
    expect(spans.map((span) => span.name)).toEqual(["POST /.otel/v1/:signal"])
    expect(spans[0]?.kind).toBe(SpanKind.SERVER)
    expect(spans.some((span) => span.name === "session.resolve")).toBe(false)
  })

  it("keeps API session reads on the server span", async () => {
    getSessionMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return {
        user: { id: "user_api", email: "api@example.com" },
        session: {
          id: "sess_api",
          userId: "user_api",
          activeOrganizationId: "org_should_not_be_copied_here",
        },
      }
    })
    const app = createTracedSessionApp()
    const response = await app.request(
      "http://backend.test/acme/api/v1/repositories",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "user_api" })
    expect(getSessionMock).toHaveBeenCalledTimes(1)

    const spans = exporter.getFinishedSpans()
    const server = spans.find((span) => span.kind === SpanKind.SERVER)
    const child = spans.find((span) => span.name === "GET /get-session")
    expect(server?.name).toBe("GET /acme/api/v1/repositories")
    expect(server?.attributes["enduser.id"]).toBe("user_api")
    expect(server?.attributes["ctxpipe.actor.type"]).toBe("user")
    expect(server?.attributes["ctxpipe.org.id"]).toBeUndefined()
    expect(spans.some((span) => span.name === "session.resolve")).toBe(false)
    expect(child?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId)
  })

  it("parents a session read that has no server span", async () => {
    getSessionMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return {
        user: { id: "user_orphan", email: "orphan@example.com" },
        session: { id: "sess_orphan", userId: "user_orphan" },
      }
    })
    const app = new Hono<AppEnv>()
    bindRequestContext(app)
    app.use("*", withSharedCookieSession)
    app.get("/acme/api/v1/repositories", (c) => c.text("ok"))

    const response = await app.request(
      "http://backend.test/acme/api/v1/repositories",
    )
    expect(response.status).toBe(200)
    const spans = exporter.getFinishedSpans()
    const parent = spans.find((span) => span.name === "session.resolve")
    const child = spans.find((span) => span.name === "GET /get-session")
    expect(parent?.kind).toBe(SpanKind.INTERNAL)
    expect(parent?.parentSpanContext).toBeUndefined()
    expect(parent?.attributes["enduser.id"]).toBe("user_orphan")
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId)
    expect(spans.some((span) => span.kind === SpanKind.SERVER)).toBe(false)
  })
})

describe("auth get-session server span", () => {
  it("copies enduser.id and org from the get-session body", async () => {
    authHandlerMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return sessionResponse("org_active")
    })
    const app = createAuthApp(true)
    const response = await app.request(
      "http://backend.test/.auth/api/v1/auth/get-session",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: "user_1", email: sessionEmail },
      session: { token: sessionToken, activeOrganizationId: "org_active" },
    })
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(authHandlerMock).toHaveBeenCalledTimes(1)

    const spans = exporter.getFinishedSpans()
    const server = spans.find((span) => span.kind === SpanKind.SERVER)
    const child = spans.find((span) => span.name === "GET /get-session")
    expect(server?.attributes).toMatchObject({
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_active",
      "ctxpipe.actor.type": "user",
    })
    expect(JSON.stringify(server?.attributes)).not.toContain(sessionToken)
    expect(JSON.stringify(server?.attributes)).not.toContain(sessionEmail)
    expect(spans.some((span) => span.name === "session.resolve")).toBe(false)
    expect(child?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId)
  })

  it("leaves the server span anonymous when get-session has no user", async () => {
    authHandlerMock.mockResolvedValue(
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    const app = createAuthApp(true)
    const response = await app.request(
      "http://backend.test/.auth/api/v1/auth/get-session",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
    expect(getSessionMock).not.toHaveBeenCalled()
    const server = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.SERVER)
    expect(server?.attributes["enduser.id"]).toBeUndefined()
    expect(server?.attributes["ctxpipe.org.id"]).toBeUndefined()
  })

  it("does not copy a user off other auth responses", async () => {
    authHandlerMock.mockResolvedValue(sessionResponse("org_active"))
    const app = createAuthApp(true)
    const response = await app.request(
      "http://backend.test/.auth/api/v1/auth/sign-in/email",
      { method: "POST" },
    )
    expect(response.status).toBe(200)
    const server = exporter
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.SERVER)
    expect(server?.attributes["enduser.id"]).toBeUndefined()
    expect(server?.attributes["ctxpipe.org.id"]).toBeUndefined()
  })

  it("parents get-session when the auth route has no server span", async () => {
    authHandlerMock.mockImplementation(async () => {
      startBetterAuthChild("GET /get-session")
      return sessionResponse("org_fallback")
    })
    const app = createAuthApp(false)
    const response = await app.request(
      "http://backend.test/.auth/api/v1/auth/get-session",
    )
    expect(response.status).toBe(200)
    expect(getSessionMock).not.toHaveBeenCalled()
    const spans = exporter.getFinishedSpans()
    const parent = spans.find((span) => span.name === "session.resolve")
    const child = spans.find((span) => span.name === "GET /get-session")
    expect(parent?.kind).toBe(SpanKind.INTERNAL)
    expect(parent?.attributes).toMatchObject({
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_fallback",
      "ctxpipe.actor.type": "user",
    })
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId)
    expect(spans.some((span) => span.kind === SpanKind.SERVER)).toBe(false)
  })
})
