import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AppEnv } from "../app/env.js"
import {
  MCP_BRAND_ICON_192_PATH,
  MCP_BRAND_LOGO_PATH,
} from "../mcp/mcp-server-info.js"
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

  it("serves PNG at the well-known path", async () => {
    const app = createTestApp()
    const res = await app.request(MCP_BRAND_ICON_192_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/png")
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(buf[0]).toBe(0x89)
    expect(buf[1]).toBe(0x50)
    expect(buf[2]).toBe(0x4e)
    expect(buf[3]).toBe(0x47)
  })
})
