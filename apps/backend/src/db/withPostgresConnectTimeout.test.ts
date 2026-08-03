import { describe, expect, it } from "vitest"
import {
  POSTGRES_CONNECT_TIMEOUT_SECONDS,
  withPostgresConnectTimeout,
} from "./withPostgresConnectTimeout.js"

describe("withPostgresConnectTimeout", () => {
  it("adds connect_timeout=30 when missing", () => {
    const out = withPostgresConnectTimeout(
      "postgresql://u:p@host:5432/db?sslmode=require",
    )
    const url = new URL(out)
    expect(url.searchParams.get("connect_timeout")).toBe(
      String(POSTGRES_CONNECT_TIMEOUT_SECONDS),
    )
    expect(url.searchParams.get("sslmode")).toBe("require")
  })

  it("does not override an existing connect_timeout", () => {
    const out = withPostgresConnectTimeout(
      "postgresql://u:p@host:5432/db?connect_timeout=10",
    )
    expect(new URL(out).searchParams.get("connect_timeout")).toBe("10")
  })

  it("returns non-URL strings unchanged", () => {
    expect(withPostgresConnectTimeout("not a url")).toBe("not a url")
  })
})
