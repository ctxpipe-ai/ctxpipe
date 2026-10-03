import { describe, expect, it } from "vitest"
import {
  githubSetupLinkStateFromSummaries,
  isAmbiguousGithubConnectionsError,
} from "./github-connector"

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

describe("githubSetupLinkStateFromSummaries", () => {
  it("is linked when any connection has a real installation id", () => {
    expect(
      githubSetupLinkStateFromSummaries([
        { installationId: null },
        { installationId: 88 },
      ]),
    ).toBe("linked")
  })

  it("stays unlinked when every connection is a draft", () => {
    expect(
      githubSetupLinkStateFromSummaries([
        { installationId: null },
        { installationId: null },
      ]),
    ).toBe("unlinked")
  })
})
