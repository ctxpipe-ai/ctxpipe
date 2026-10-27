import { describe, expect, it } from "vitest"

import { parseEnv } from "./env.js"

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe",
  AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
}

describe("parseEnv Zendesk optional secrets", () => {
  it("treats empty Zendesk secrets as unset", () => {
    expect(() =>
      parseEnv({
        ...base,
        ZENDESK_CLIENT_ID: "",
        ZENDESK_CLIENT_SECRET: "",
      } as Record<string, string | undefined>),
    ).not.toThrow()
  })

  it("passes Zendesk values through", () => {
    const env = parseEnv({
      ...base,
      ZENDESK_CLIENT_ID: "zd-client",
      ZENDESK_CLIENT_SECRET: "zd-secret",
    } as Record<string, string | undefined>)
    expect(env.ZENDESK_CLIENT_ID).toBe("zd-client")
    expect(env.ZENDESK_CLIENT_SECRET).toBe("zd-secret")
  })
})
