import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  getSessionMock,
  authHandlerMock,
  startCodeIngestionWorkerMock,
  registerLangsmithRoutesMock,
} =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    authHandlerMock: vi.fn(),
    startCodeIngestionWorkerMock: vi.fn(),
    registerLangsmithRoutesMock: vi.fn(),
  }))

vi.mock("../auth/config.js", () => ({
  getBetterAuth: () => ({
    api: { getSession: getSessionMock },
    handler: authHandlerMock,
  }),
}))

vi.mock("../domain/codeIngestion/worker.js", () => ({
  startCodeIngestionWorker: startCodeIngestionWorkerMock,
}))

vi.mock("../routes/langsmith.js", () => ({
  registerLangsmithRoutes: registerLangsmithRoutesMock,
}))

vi.mock("../routes/v1/index.js", () => ({
  registerV1Routes: (app: {
    use: (
      path: string,
      handler: (
        c: {
          req: { raw: { headers: Headers } }
          json: (body: unknown, status: number) => Response
        },
        next: () => Promise<void>,
      ) => Promise<unknown>,
    ) => void
    get: (path: string, handler: () => Response) => void
  }) => {
    app.use("/:orgSlug/api/v1/*", async (c, next) => {
      const authSession = await getSessionMock({
        headers: c.req.raw.headers,
      })
      if (!authSession) {
        return c.json({ error: "Unauthorized" }, 401)
      }
      return next()
    })
    app.get("/:orgSlug/api/v1/health", () => new Response("ok"))
    return app
  },
}))

vi.mock("../routes/openapi.js", () => ({
  registerOpenapiRoutes: vi.fn(),
}))

vi.mock("../routes/mcp.js", () => ({
  registerMcpRoutes: vi.fn(),
}))

import { createApp } from "./app.js"

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"

describe("UI fallback proxy for unmatched backend routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_SECRET = AUTH_SECRET
    process.env.DATABASE_URL = "postgres://localhost:5432/ctxpipe"
    process.env.UI_PROXY_URL = "http://ui-bun:3002"
    process.env.ENABLE_LANGSMITH = "false"
    getSessionMock.mockResolvedValue(null)
    authHandlerMock.mockImplementation(() => new Response("auth", { status: 200 }))
  })

  afterEach(() => {
    delete process.env.AUTH_SECRET
    delete process.env.UI_PROXY_URL
    delete process.env.ENABLE_LANGSMITH
    delete process.env.DATABASE_URL
  })

  it("keeps known backend routes local and protected by auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const app = createApp()
    const res = await app.request("/acme/api/v1/health")

    expect(res.status).toBe(401)
    expect(getSessionMock).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("proxies unknown routes to UI without requiring backend auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ui page", { status: 200 }))
    const app = createApp()
    const res = await app.request("/dashboard?tab=home")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ui page")
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const [target] = fetchSpy.mock.calls[0] as [Request]
    expect(target.url).toBe("http://ui-bun:3002/dashboard?tab=home")
    expect(target.method).toBe("GET")
  })

  it("forwards method, query, headers, and body for non-GET routes", async () => {
    let seenRequest:
      | {
          url: string
          method: string
          contentType: string | null
          customHeader: string | null
          body: string
        }
      | undefined

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const upstreamRequest = new Request(input, init)
      seenRequest = {
        url: upstreamRequest.url,
        method: upstreamRequest.method,
        contentType: upstreamRequest.headers.get("content-type"),
        customHeader: upstreamRequest.headers.get("x-custom-header"),
        body: await upstreamRequest.text(),
      }
      return new Response("proxied", { status: 201 })
    })

    const app = createApp()
    const body = JSON.stringify({ action: "save" })
    const res = await app.request("/submit?source=test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-header": "keep-me",
      },
      body,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("proxied")
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(seenRequest).toEqual({
      url: "http://ui-bun:3002/submit?source=test",
      method: "POST",
      contentType: "application/json",
      customHeader: "keep-me",
      body,
    })
  })
})
