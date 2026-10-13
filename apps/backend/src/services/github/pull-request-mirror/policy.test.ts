import { describe, expect, it } from "vitest"
import { shouldMirrorGithubPullRequest } from "./policy.js"

describe("shouldMirrorGithubPullRequest", () => {
  it("accepts closed pull requests, merged or not, that are not drafts", () => {
    expect(
      shouldMirrorGithubPullRequest({
        state: "closed",
        merged: true,
        draft: false,
      }),
    ).toBe(true)
    expect(
      shouldMirrorGithubPullRequest({
        state: "closed",
        merged: false,
        draft: false,
      }),
    ).toBe(true)
    expect(
      shouldMirrorGithubPullRequest({
        state: "closed",
        merged: false,
        draft: true,
      }),
    ).toBe(false)
  })

  it("rejects open pull requests", () => {
    expect(
      shouldMirrorGithubPullRequest({
        state: "open",
        merged: false,
        draft: false,
      }),
    ).toBe(false)
  })
})
