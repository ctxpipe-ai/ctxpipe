import { describe, expect, it } from "vitest"
import {
  chromePullRequestAction,
  conversationGithubPullUrl,
  shellSingleQuote,
} from "./conversation-publish.js"

describe("conversation publish", () => {
  it("quotes commit messages for the leftover commit", () => {
    expect(shellSingleQuote("Repo layout")).toBe("'Repo layout'")
    expect(shellSingleQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  it("builds the public pull request URL", () => {
    expect(
      conversationGithubPullUrl({ repositoryName: "acme/docs", prNumber: 41 }),
    ).toBe("https://github.com/acme/docs/pull/41")
  })

  it("returns Create PR after a merged or closed PR", () => {
    expect(chromePullRequestAction("open")).toBe("show")
    expect(chromePullRequestAction("merged")).toBe("create")
    expect(chromePullRequestAction(null)).toBe("create")
  })
})
