import { describe, expect, it } from "vitest"
import { shouldMirrorGithubPullRequest } from "./policy.js"

describe("shouldMirrorGithubPullRequest", () => {
  it("accepts closed pull requests that are not drafts", () => {
    expect(
      shouldMirrorGithubPullRequest({ state: "closed", draft: false }),
    ).toBe(true)
    expect(
      shouldMirrorGithubPullRequest({ state: "closed", draft: true }),
    ).toBe(false)
  })

  it("rejects open pull requests", () => {
    expect(shouldMirrorGithubPullRequest({ state: "open", draft: false })).toBe(
      false,
    )
  })
})
