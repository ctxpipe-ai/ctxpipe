import type { AppEnv } from "../app/env.js"
import type { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../graphs/index.js", () => ({
  hello: {},
}))

import { Hono as HonoApp } from "hono"
import { registerLangsmithRoutes } from "./langsmith.js"

describe("registerLangsmithRoutes", () => {
  beforeEach(() => {
    delete process.env.ENABLE_LANGSMITH
  })

  it("does not mount routes when ENABLE_LANGSMITH is disabled", async () => {
    process.env.ENABLE_LANGSMITH = "false"

    const app: Hono<AppEnv> = new HonoApp<AppEnv>()
    registerLangsmithRoutes(app)

    const response = await app.request("/langsmith/ok")
    expect(response.status).toBe(404)
  })
})
