import { describe, expect, it } from "vitest"
import { shouldMirrorGithubPullRequest } from "./policy.js"

describe("shouldMirrorGithubPullRequest", () => {
  it("accepts only merged pull requests that are not drafts", () => {
    expect(shouldMirrorGithubPullRequest({ merged: true, draft: false })).toBe(
      true,
    )
    expect(shouldMirrorGithubPullRequest({ merged: false, draft: false })).toBe(
      false,
    )
    expect(shouldMirrorGithubPullRequest({ merged: true, draft: true })).toBe(
      false,
    )
  })
})
