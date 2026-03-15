import { describe, expect, it, vi } from "vitest"

vi.mock("../../routes/v1/index.js", () => ({
  registerV1Routes: (app: {
    get: (path: string, handler: () => Response) => void
  }) => {
    app.get("/.status", () =>
      Response.json({ status: "ok", timestamp: new Date().toISOString() }),
    )
    return app
  },
}))

vi.mock("../../routes/auth.js", () => ({
  registerAuthRoutes: vi.fn(),
}))

vi.mock("../../routes/openapi.js", () => ({
  registerOpenapiRoutes: vi.fn(),
}))

vi.mock("../../routes/mcp.js", () => ({
  registerMcpRoutes: vi.fn(),
}))

vi.mock("../../routes/langsmith.js", () => ({
  registerLangsmithRoutes: vi.fn(),
}))

vi.mock("../../models/repositories.js", () => ({
  getRepository: vi.fn(),
  listRepositories: vi.fn(),
}))

describe("GET /.status", () => {
  it("returns 200 and status ok", async () => {
    process.env.MODEL_PROVIDER_API_KEY = "test-model-key"
    process.env.AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
    process.env.DATABASE_URL = "postgres://localhost:5432/ctxpipe"
    process.env.UI_PROXY_URL = "http://ui-bun:3002"
    process.env.ENABLE_LANGSMITH = "false"
    const { createApp } = await import("../../app/app.js")
    const app = createApp()
    const res = await app.request("/.status")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; timestamp: string }
    expect(body).toHaveProperty("status", "ok")
    expect(body).toHaveProperty("timestamp")
    expect(typeof body.timestamp).toBe("string")
    delete process.env.AUTH_SECRET
    delete process.env.DATABASE_URL
    delete process.env.UI_PROXY_URL
    delete process.env.ENABLE_LANGSMITH
    delete process.env.MODEL_PROVIDER_API_KEY
  })
})
