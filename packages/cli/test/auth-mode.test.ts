import { describe, expect, it } from "vitest"
import { resolveMcpAuth, validateAuthMode } from "../src/mcp/auth-mode.js"

describe("MCP auth mode", () => {
  it("defaults missing auth to OAuth and ignores CTXPIPE_API_KEY", () => {
    expect(resolveMcpAuth({})).toEqual({ mode: "oauth" })
    expect(resolveMcpAuth({ auth: "  " })).toEqual({ mode: "oauth" })
    expect(resolveMcpAuth({ auth: null })).toEqual({ mode: "oauth" })
  })

  it("returns api-key auth from --auth without reading a key", () => {
    expect(resolveMcpAuth({ auth: "api-key" })).toEqual({ mode: "api-key" })
    expect(resolveMcpAuth({ auth: " api-key " })).toEqual({ mode: "api-key" })
  })

  it("accepts explicit OAuth", () => {
    expect(resolveMcpAuth({ auth: "oauth" })).toEqual({ mode: "oauth" })
  })

  it("rejects unknown auth modes", () => {
    expect(() => validateAuthMode("bearer")).toThrow("--auth must be one of")
    expect(() => resolveMcpAuth({ auth: "bearer" })).toThrow(
      "--auth must be one of",
    )
  })
})
