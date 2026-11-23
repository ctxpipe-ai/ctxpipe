import { Hono } from "hono"
import { describe, expect, it } from "vitest"

import type { AppEnv } from "../app/env.js"
import { registerMcpRoutes } from "./mcp.js"

describe("POST /mcp body size", () => {
  it("refuses a body over 4 MiB before auth reads anything", async () => {
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "http://localhost:3000",
      } as AppEnv["Variables"]["env"])
      await next()
    })
    registerMcpRoutes(app, {
      registerTools: () => {},
      instructions: async () => "",
    })

    const response = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: `[${'"x",'.repeat(1024 * 1024)}"x"]`,
    })

    expect(response.status).toBe(413)
  })
})
