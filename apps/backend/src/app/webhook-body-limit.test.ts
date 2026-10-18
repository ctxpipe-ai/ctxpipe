import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The app loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

const MB = 1024 * 1024

describe("webhook body limit, through the whole app", () => {
  let app: Awaited<ReturnType<typeof import("./app.js")["createApp"]>>

  beforeAll(async () => {
    // setup-evlog turns logging off, and then evlog() sets no `c.var.log`.
    // Turn it on as in production.
    initLogger({
      enabled: true,
      silent: true,
      env: { service: "ctxpipe-backend-test" },
    })
    vi.stubEnv("AUTH_SECRET", "abcdefghijklmnopqrstuvwxyz123456")
    vi.stubEnv("DATABASE_URL", "postgres://localhost:5432/ctxpipe")
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "github-webhook-secret")
    const { createApp } = await import("./app.js")
    app = createApp()
  })

  afterAll(() => {
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    vi.unstubAllEnvs()
  })

  function post(path: string, bytes: number) {
    return app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(bytes),
    })
  }

  it.each([
    "/api/v1/webhook/slack",
    "/api/v1/webhook/linear",
    "/api/v1/webhook/notion",
    "/api/v1/webhook/pagerduty",
    "/api/v1/webhook/atlassian/forge",
    "/api/v1/webhook/atlassian/forge/token-refresh",
  ])("answers 413 to a body over 1 MB on %s", async (path) => {
    const response = await post(path, MB + 1)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "Payload too large" })
  })

  it("lets a GitHub body over 1 MB through to the signature check", async () => {
    // The unsigned body reaches the handler and fails the signature check.
    const response = await post("/api/v1/webhook/github", 2 * MB)
    expect(response.status).toBe(401)
  })

  it("answers 413 to a GitHub body over 25 MB", async () => {
    const response = await post("/api/v1/webhook/github", 25 * MB + 1)
    expect(response.status).toBe(413)
    const scoped = await post("/api/v1/webhook/github/con_any", 25 * MB + 1)
    expect(scoped.status).toBe(413)
  })
})
