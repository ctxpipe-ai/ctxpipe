import { describe, expect, it } from "vitest"
import { parseEnv } from "./env.js"

describe("parseEnv PagerDuty optional secrets", () => {
  it("treats empty PagerDuty secrets as unset", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://localhost:5432/ctxpipe",
        AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
        PAGERDUTY_CLIENT_ID: "",
        PAGERDUTY_CLIENT_SECRET: "",
        PAGERDUTY_REDIRECT_URI: "",
      } as Record<string, string | undefined>),
    ).not.toThrow()
  })
})
