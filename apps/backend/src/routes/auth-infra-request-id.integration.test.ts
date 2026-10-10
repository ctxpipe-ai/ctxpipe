import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../test/msw.js"
import { closeDb } from "../db/client.js"
import { withTestLogger } from "../test/with-test-logger.js"

// The Better Auth infra plugin (`dash()`) reads `X-Request-Id` as its own
// identification id. Railway and our request-id middleware set that header on
// every request. When it reaches the auth handler, the plugin stores it in the
// `__infra-rid` cookie, and each later server-side session lookup asks the
// infra KV for `/identify/<id>`, gets 404, and retries (about 1.1 s each).
const kvIdentifyCalls: string[] = []

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.get("https://kv.better-auth.com/identify/:id", ({ params }) => {
    kvIdentifyCalls.push(String(params.id))
    return new HttpResponse(null, { status: 404 })
  }),
  http.all("https://kv.better-auth.com/*", () => HttpResponse.json({})),
  http.all("https://dash.better-auth.com/*", () => HttpResponse.json({})),
)

function cookiePairs(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
}

describe("auth requests and the Better Auth infra request id", () => {
  let app: Awaited<ReturnType<typeof import("../app/app.js")["createApp"]>>

  beforeAll(async () => {
    const { config } = await import("dotenv")
    config({
      path: new URL("../../.env.local", import.meta.url).pathname,
      override: false,
      quiet: true,
    })
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is unset: run pnpm dev:infra")
    }
    vi.stubEnv("BETTER_AUTH_API_KEY", "ba_test_infra_key")
    const { resetBetterAuthForTests } = await import("../auth/config.js")
    resetBetterAuthForTests()
    const { createApp } = await import("../app/app.js")
    app = createApp()
  })

  afterAll(async () => {
    const { resetBetterAuthForTests } = await import("../auth/config.js")
    resetBetterAuthForTests()
    vi.unstubAllEnvs()
    await closeDb()
  })

  it("does not turn the request id into slow session lookups", async () => {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
    const signUp = await app.request("/.auth/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-request-id": `rid-${suffix}`,
      },
      body: JSON.stringify({
        name: "Infra request id",
        email: `infra-rid-${suffix}@example.com`,
        password: "integration-infra-password",
      }),
    })
    expect(signUp.status).toBe(200)
    const cookies = cookiePairs(signUp)
    expect(cookies.some((pair) => pair.startsWith("__infra-rid="))).toBe(false)

    const before = kvIdentifyCalls.length
    // evlog is off in tests, so the request has no Hono logger.
    const res = await withTestLogger(async () =>
      app.request("/no-such-org/api/v1/workspaces", {
        headers: { origin, cookie: cookies.join("; ") },
      }),
    )
    expect(res.status).toBe(404)
    expect(kvIdentifyCalls.slice(before)).toEqual([])
  })
})
