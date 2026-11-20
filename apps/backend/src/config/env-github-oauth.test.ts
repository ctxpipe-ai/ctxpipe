import { describe, expect, it } from "vitest"

import { parseEnv } from "./env.js"

const required = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
}

describe("parseEnv GitHub OAuth forwarder URLs", () => {
  it("takes both URLs, or neither", () => {
    expect(() => parseEnv(required)).not.toThrow()
    expect(() =>
      parseEnv({
        ...required,
        GITHUB_AUTHORIZE_URL: "https://forwarder.example.test/authorize/pr-1",
        GITHUB_REDIRECT_URI: "https://forwarder.example.test/callback",
      }),
    ).not.toThrow()
  })

  it.each([
    ["GITHUB_AUTHORIZE_URL", "https://forwarder.example.test/authorize/pr-1"],
    ["GITHUB_REDIRECT_URI", "https://forwarder.example.test/callback"],
  ])(
    "refuses %s alone, so a half-set deployment does not start",
    (name, value) => {
      expect(() => parseEnv({ ...required, [name]: value })).toThrow(
        /GITHUB_AUTHORIZE_URL and GITHUB_REDIRECT_URI/,
      )
    },
  )
})
