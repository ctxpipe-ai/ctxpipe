import { existsSync, readFileSync } from "node:fs"
import type { Hono } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  getMcpBrandLogoAbsolutePath,
  MCP_BRAND_LOGO_PATH,
} from "../mcp/mcp-server-info.js"

/**
 * Serves the ctx| brand mark for MCP client UIs (e.g. CodeRabbit) that load
 * `icons[].src` over HTTPS instead of inline data URIs.
 */
export function registerMcpBrandAssetRoute(app: Hono<AppEnv>) {
  app.get(MCP_BRAND_LOGO_PATH, (c) => {
    const path = getMcpBrandLogoAbsolutePath()
    if (!existsSync(path)) {
      return c.body(null, 404)
    }
    const body = readFileSync(path)
    c.header("Content-Type", "image/svg+xml")
    c.header("Cache-Control", "public, max-age=86400")
    return c.body(body, 200)
  })
}
