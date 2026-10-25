import { describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { ingestCallbackOrigin } from "./ingest-shard-runtime.js"

/*
 * Shard steps run in the worker. The sandbox must call the API, never the
 * worker's address or the worker's PORT.
 */

const base = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost:5432/fixture",
  AUTH_SECRET: "x".repeat(32),
}

describe("ingestCallbackOrigin", () => {
  it("uses the API service on the sandbox network in Compose, on the PORT of the API service config", () => {
    // Compose gives the worker the API service's PORT (one YAML anchor).
    const env = parseEnv({
      ...base,
      AUTH_BASE_URL: "http://localhost:3000",
      SANDBOX_CALLBACK_HOST: "backend.sandbox.ctxpipe.internal",
      PORT: "8080",
    })
    expect(ingestCallbackOrigin(env)).toBe(
      "http://backend.sandbox.ctxpipe.internal:8080",
    )
  })

  it.each([
    "http://backend",
    "backend:3000",
    "backend/path",
    "user@backend",
    "backend?x=1",
  ])("refuses the callback host %j, as the chat callback does", (host) => {
    const env = parseEnv({
      ...base,
      AUTH_BASE_URL: "http://localhost:3000",
      SANDBOX_CALLBACK_HOST: host,
    })
    expect(() => ingestCallbackOrigin(env)).toThrow(
      "SANDBOX_CALLBACK_HOST must be a hostname or IP address",
    )
  })

  it("uses the default port 3000 in Compose, also when the public port is another", () => {
    const env = parseEnv({
      ...base,
      AUTH_BASE_URL: "https://ctxpipe.example.com:8443",
      SANDBOX_CALLBACK_HOST: "backend.sandbox.ctxpipe.internal",
    })
    expect(ingestCallbackOrigin(env)).toBe(
      "http://backend.sandbox.ctxpipe.internal:3000",
    )
  })

  it("uses the public API origin on AWS and Railway, not the worker's PORT", () => {
    const env = parseEnv({
      ...base,
      AUTH_BASE_URL: "https://ctxpipe.example.com",
      PORT: "3002",
    })
    expect(ingestCallbackOrigin(env)).toBe("https://ctxpipe.example.com")
  })

  it("reaches a localhost API in host dev through host.docker.internal", () => {
    const env = parseEnv({ ...base, AUTH_BASE_URL: "http://localhost:3000" })
    expect(ingestCallbackOrigin(env)).toBe("http://host.docker.internal:3000")
  })
})
