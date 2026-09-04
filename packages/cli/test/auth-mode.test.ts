import { describe, expect, it } from "vitest"
import { resolveMcpAuth, validateAuthMode } from "../src/mcp/auth-mode.js"

describe("MCP auth mode", () => {
  it("defaults missing auth to OAuth and ignores a stray key", () => {
    expect(
      resolveMcpAuth({
        env: { CTXPIPE_API_KEY: "ctxp_env" },
      }),
    ).toEqual({ mode: "oauth" })
  })

  it("treats --api-key as explicit literal API-key auth", () => {
    expect(resolveMcpAuth({ apiKey: " ctxp_flag " })).toEqual({
      mode: "api-key",
      placement: "literal",
      apiKey: "ctxp_flag",
    })
  })

  it("treats --api-key-env-variable as explicit env-reference API-key auth", () => {
    expect(
      resolveMcpAuth({
        apiKeyEnvVariable: " MY_CTXPIPE_KEY ",
        env: { MY_CTXPIPE_KEY: "ctxp_should_not_be_read" },
      }),
    ).toEqual({
      mode: "api-key",
      placement: "env",
      envVariable: "MY_CTXPIPE_KEY",
    })
  })

  it("does not require the env variable to be set when writing a reference", () => {
    expect(
      resolveMcpAuth({
        auth: "api-key",
        apiKeyEnvVariable: "CTXPIPE_API_KEY",
        env: { CTXPIPE_API_KEY: "" },
      }),
    ).toEqual({
      mode: "api-key",
      placement: "env",
      envVariable: "CTXPIPE_API_KEY",
    })
  })

  it("rejects combining --api-key and --api-key-env-variable", () => {
    expect(() =>
      resolveMcpAuth({
        apiKey: "ctxp_flag",
        apiKeyEnvVariable: "CTXPIPE_API_KEY",
      }),
    ).toThrow("either --api-key or --api-key-env-variable")
  })

  it("requires a key or env variable name for --auth api-key", () => {
    expect(() =>
      resolveMcpAuth({ auth: "api-key", env: { CTXPIPE_API_KEY: "" } }),
    ).toThrow("Missing API key")
  })

  it("accepts --auth api-key with CTXPIPE_API_KEY as a literal key", () => {
    expect(
      resolveMcpAuth({
        auth: "api-key",
        env: { CTXPIPE_API_KEY: "ctxp_env" },
      }),
    ).toEqual({
      mode: "api-key",
      placement: "literal",
      apiKey: "ctxp_env",
    })
  })

  it("rejects an invalid environment variable name", () => {
    expect(() => resolveMcpAuth({ apiKeyEnvVariable: "ctxpipe-key" })).toThrow(
      "valid environment variable name",
    )
  })

  it("rejects unknown auth modes", () => {
    expect(() => validateAuthMode("bearer")).toThrow("--auth must be one of")
  })
})
