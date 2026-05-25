import { describe, expect, it } from "vitest"
import { DrizzleQueryError } from "drizzle-orm"
import { redactQueryParams, sanitizeDbError } from "./sanitize-db-error.js"

describe("redactQueryParams", () => {
  it("redacts params when query selects sessions by token", () => {
    const query =
      'select ... from "sessions" where "sessions"."token" = $1'
    const redacted = redactQueryParams(["sess_secret_token_value"], query)
    expect(redacted).toEqual(["<redacted len=23>"])
  })

  it("leaves params unchanged for non-sensitive queries", () => {
    expect(redactQueryParams(["org_abc"], 'select "id" from "organizations"')).toEqual([
      "org_abc",
    ])
  })
})

describe("sanitizeDbError", () => {
  it("strips session token from DrizzleQueryError message", () => {
    const cause = new Error("Connection terminated unexpectedly")
    const err = new DrizzleQueryError(
      'select "id" from "sessions" where "sessions"."token" = $1',
      ["super_secret_session_token"],
      cause,
    )

    const sanitized = sanitizeDbError(err) as Error
    expect(sanitized.message).toContain("<redacted len=")
    expect(sanitized.message).not.toContain("super_secret_session_token")
  })

  it("returns non-drizzle errors unchanged", () => {
    const err = new Error("other")
    expect(sanitizeDbError(err)).toBe(err)
  })
})
