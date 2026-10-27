import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withTestLogger } from "../../test/with-test-logger.js"

// The app loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

describe("a personal API key is read-only on REST (Postgres)", () => {
  let seed: SeededOrg | undefined
  let app: Awaited<ReturnType<(typeof import("../../app/app.js"))["createApp"]>>

  function requireSeed(): SeededOrg {
    if (!seed) throw new Error("seedOrg did not run")
    return seed
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedOrg()
    const { createApp } = await import("../../app/app.js")
    app = createApp()
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  function send(
    method: string,
    path: string,
    credential: Record<string, string>,
    body?: unknown,
  ) {
    return withTestLogger(async () =>
      app.request(`http://localhost${path}`, {
        method,
        headers: {
          origin: process.env.AUTH_BASE_URL ?? "http://localhost:3000",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...credential,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  }

  const key = () => ({ "x-api-key": requireSeed().personalApiKey })
  const cookie = () => ({ cookie: requireSeed().cookie })

  it("refuses the key on an admin route that takes no write grant", async () => {
    const path = `/${requireSeed().orgSlug}/api/v1/github/installation`
    const response = await send("POST", path, key(), { installationId: 1 })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: "write_grant_required",
    })
    // A session of the same owner passes the gate and reaches the handler.
    expect((await send("POST", path, cookie(), {})).status).not.toBe(403)
  })

  it("refuses the key on a change to a conversation", async () => {
    const path = `/${requireSeed().orgSlug}/api/v1/conversations/conv_missing`
    expect((await send("DELETE", path, key())).status).toBe(403)
    expect((await send("DELETE", path, cookie())).status).toBe(404)
  })

  it("refuses the key on an admin read", async () => {
    const path = `/${requireSeed().orgSlug}/api/v1/github/installation/connector-status?connectionId=con_missing`
    const response = await send("GET", path, key())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Forbidden" })
    expect((await send("GET", path, cookie())).status).toBe(404)
  })

  it("still lets the key read a member route", async () => {
    const path = `/${requireSeed().orgSlug}/api/v1/workspaces`
    expect((await send("GET", path, key())).status).toBe(200)
  })
})
