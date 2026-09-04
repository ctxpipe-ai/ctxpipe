import { describe, expect, it } from "vitest"
import { resolveMcpApiKey, validateAuthMode } from "../src/mcp/auth-mode.js"

describe("MCP auth mode", () => {
  it("defaults missing auth to OAuth and ignores a key", () => {
    expect(
      resolveMcpApiKey({
        apiKey: "ctxp_ignored",
        env: { CTXPIPE_API_KEY: "ctxp_env" },
      }),
    ).toBeUndefined()
  })

  it("requires a key for api-key auth", () => {
    expect(() =>
      resolveMcpApiKey({ auth: "api-key", env: { CTXPIPE_API_KEY: "" } }),
    ).toThrow("Missing API key")
  })

  it("accepts --api-key or CTXPIPE_API_KEY", () => {
    expect(resolveMcpApiKey({ auth: "api-key", apiKey: " ctxp_flag " })).toBe(
      "ctxp_flag",
    )
    expect(
      resolveMcpApiKey({
        auth: "api-key",
        env: { CTXPIPE_API_KEY: "ctxp_env" },
      }),
    ).toBe("ctxp_env")
  })

  it("rejects unknown auth modes", () => {
    expect(() => validateAuthMode("bearer")).toThrow("--auth must be one of")
  })
})
