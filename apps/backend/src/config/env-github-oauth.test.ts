import { describe, expect, it } from "vitest"

import { parseEnv } from "./env.js"

const required = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
}

describe("parseEnv GitHub forwarder URLs", () => {
  it("takes both URLs, or neither", () => {
    expect(() => parseEnv(required)).not.toThrow()
    expect(() =>
      parseEnv({
        ...required,
        GITHUB_WEB_URL: "https://forwarder.example.test/.to-github/pr-1",
        GITHUB_REDIRECT_URI:
          "https://forwarder.example.test/.auth/api/v1/auth/callback/github",
      }),
    ).not.toThrow()
  })

  it.each([
    ["GITHUB_WEB_URL", "https://forwarder.example.test/.to-github/pr-1"],
    [
      "GITHUB_REDIRECT_URI",
      "https://forwarder.example.test/.auth/api/v1/auth/callback/github",
    ],
  ])(
    "refuses %s alone, so a half-set deployment does not start",
    (name, value) => {
      expect(() => parseEnv({ ...required, [name]: value })).toThrow(
        /GITHUB_WEB_URL and GITHUB_REDIRECT_URI/,
      )
    },
  )
})
