import { describe, expect, it } from "vitest"
import {
  chatPullRequestPathIsSafe,
  isChatSessionBranch,
  splitGitNulPaths,
} from "./chat-pull-request.js"

describe("chat pull request paths", () => {
  it("splits NUL-delimited git paths including names with spaces", () => {
    expect(splitGitNulPaths("knowledge/a file.md\0linear/issue.md\0")).toEqual([
      "knowledge/a file.md",
      "linear/issue.md",
    ])
    expect(splitGitNulPaths("")).toEqual([])
  })

  it("refuses path traversal", () => {
    expect(chatPullRequestPathIsSafe("knowledge/a.md")).toBe(true)
    expect(chatPullRequestPathIsSafe("knowledge/a file.md")).toBe(true)
    expect(chatPullRequestPathIsSafe("../secret")).toBe(false)
    expect(chatPullRequestPathIsSafe("/etc/passwd")).toBe(false)
    expect(chatPullRequestPathIsSafe("foo/../bar")).toBe(false)
  })

  it("accepts only conversation session branches", () => {
    expect(isChatSessionBranch("ctxpipe/chat/conv_1/1")).toBe(true)
    expect(isChatSessionBranch("main")).toBe(false)
    expect(isChatSessionBranch("ctxpipe/chat/../main")).toBe(false)
  })
})
