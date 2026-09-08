import { describe, expect, it } from "vitest"
import { effectiveValidFrom, looksLikeGitSha } from "./hydrate-phases.js"

describe("hydrate phases", () => {
  it("treats hex SHAs as missing valid_from and keeps timestamps", () => {
    expect(looksLikeGitSha("abc123")).toBe(true)
    expect(looksLikeGitSha("2026-01-01")).toBe(false)
    expect(looksLikeGitSha("2026-01-01T00:00:00.000Z")).toBe(false)
    expect(
      effectiveValidFrom({
        recorded: "abc123",
        introducingCommitTimestamp: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe("2026-08-16T12:00:00.000Z")
    expect(
      effectiveValidFrom({
        recorded: "2026-01-01",
        introducingCommitTimestamp: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe("2026-01-01")
  })
})
