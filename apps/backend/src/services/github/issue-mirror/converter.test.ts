import { describe, expect, it } from "vitest"

import type { GithubIssueSnapshot } from "./client.js"
import { renderGithubIssue } from "./converter.js"

function issueWithComments(total: number, kept: number): GithubIssueSnapshot {
  return {
    id: "I_1",
    number: 1,
    repository: "acme/api",
    url: "https://github.com/acme/api/issues/1",
    title: "Problem",
    body: "Steps to see it.",
    state: "open",
    stateReason: null,
    author: { login: "bob", type: "human" },
    labels: [],
    assignees: [],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
    closedAt: null,
    comments: Array.from({ length: kept }, (_, i) => ({
      author: { login: "carol", type: "human" as const },
      body: `Comment ${i}`,
      createdAt: "2026-03-01T00:00:00Z",
    })),
    commentsTotal: total,
    closedBy: [],
  }
}

describe("renderGithubIssue comments", () => {
  it("says how many older comments are not mirrored, before the first comment", () => {
    const { content } = renderGithubIssue(issueWithComments(101, 100))
    const note =
      "_1 older comment is not mirrored. See the issue on GitHub: https://github.com/acme/api/issues/1_"
    expect(content).toContain(note)
    expect(content.indexOf(note)).toBeLessThan(content.indexOf("### "))
  })

  it("adds no line when every comment is mirrored", () => {
    const { content } = renderGithubIssue(issueWithComments(100, 100))
    expect(content).not.toContain("not mirrored")
  })
})
