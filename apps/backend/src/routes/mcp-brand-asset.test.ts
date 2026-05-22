import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import { MCP_BRAND_LOGO_PATH } from "../mcp/mcp-server-info.js"
import { registerMcpBrandAssetRoute } from "./mcp-brand-asset.js"

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("env", { DATABASE_URL: "" } as AppEnv["Variables"]["env"])
    await next()
  })
  registerMcpBrandAssetRoute(app)
  return app
}

describe("MCP brand logo asset", () => {
  it("serves SVG at the well-known path", async () => {
    const app = createTestApp()
    const res = await app.request(MCP_BRAND_LOGO_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const text = await res.text()
    expect(text).toContain("<svg")
  })
})
