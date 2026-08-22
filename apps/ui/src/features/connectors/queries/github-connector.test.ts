import { describe, expect, it } from "vitest"
import { isAmbiguousGithubConnectionsError } from "./github-connector"

describe("isAmbiguousGithubConnectionsError", () => {
  it("treats a missing connectionId as already connected", () => {
    expect(
      isAmbiguousGithubConnectionsError({
        error:
          "Multiple GitHub connections for this organization; specify connectionId query parameter",
      }),
    ).toBe(true)
  })

  it("ignores other errors", () => {
    expect(isAmbiguousGithubConnectionsError({ error: "Unauthorized" })).toBe(
      false,
    )
    expect(isAmbiguousGithubConnectionsError(null)).toBe(false)
  })
})
