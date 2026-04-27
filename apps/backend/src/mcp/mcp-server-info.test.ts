import { describe, expect, it } from "vitest"
import {
  getMcpServerImplementation,
  MCP_BRAND_ICON_192_PATH,
  MCP_BRAND_LOGO_PATH,
} from "./mcp-server-info.js"

describe("getMcpServerImplementation", () => {
  it("lists a PNG icon URL first for MCP clients that skip SVG", () => {
    const base = "https://example.com"
    const impl = getMcpServerImplementation(base)
    expect(impl.icons?.length).toBeGreaterThanOrEqual(2)
    expect(impl.icons?.[0]).toEqual({
      src: `${base}${MCP_BRAND_ICON_192_PATH}`,
      mimeType: "image/png",
      sizes: ["192x192"],
    })
    const last = impl.icons?.[impl.icons.length - 1]
    expect(last?.src).toBe(`${base}${MCP_BRAND_LOGO_PATH}`)
    expect(last?.mimeType).toBe("image/svg+xml")
  })
})
