import { describe, expect, it } from "vitest"
import {
  githubPullRequestMarkdownPath,
  isGithubPullRequestMirrorPath,
  parseGithubPullRequestMarkdown,
  renderGithubPullRequest,
} from "./converter.js"
import type { GithubPullRequestSnapshot } from "./types.js"

const snapshot: GithubPullRequestSnapshot = {
  id: 987654,
  number: 42,
  repository: "acme/api",
  url: "https://github.com/acme/api/pull/42",
  title: "Reject god objects in handlers",
  body: "Keep domain logic out of the HTTP layer.",
  state: "closed",
  merged: true,
  draft: false,
  author: { login: "alice", type: "human" },
  base: { ref: "main", sha: "aaa1111" },
  head: { ref: "feat/handlers", sha: "bbb2222" },
  reviewDecision: "APPROVED",
  labels: ["backend"],
  requestedReviewers: ["bob"],
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-02T11:00:00.000Z",
  mergedAt: "2026-03-02T11:00:00.000Z",
  files: [
    { path: "src/http/createUser.ts", status: "modified" },
    { path: "src/domain/user.ts", status: "added" },
    { path: "src/legacy.ts", status: "removed" },
    {
      path: "src/users/service.ts",
      status: "renamed",
      previousPath: "src/userService.ts",
    },
  ],
  reviews: [
    {
      id: 1,
      author: { login: "bob", type: "human" },
      state: "APPROVED",
      body: "Yes — handlers stay thin.",
      submittedAt: "2026-03-02T10:30:00.000Z",
    },
    {
      id: 2,
      author: { login: "coderabbitai", type: "bot" },
      state: "COMMENTED",
      body: "Consider adding a test.",
      submittedAt: "2026-03-02T10:10:00.000Z",
    },
  ],
  comments: [
    {
      id: 11,
      kind: "review",
      author: { login: "bob", type: "human" },
      body: "Move this into the domain module.",
      createdAt: "2026-03-02T10:20:00.000Z",
      path: "src/http/createUser.ts",
      line: 18,
    },
  ],
  requiredChecks: [{ name: "ci", conclusion: "success" }],
}

describe("renderGithubPullRequest", () => {
  it("writes a stable path and frontmatter that parse back to the change list", () => {
    const file = renderGithubPullRequest(snapshot)

    expect(file.path).toBe("github/pulls/acme/api/42--987654.md")
    expect(file.content).toContain("Keep domain logic out of the HTTP layer.")
    expect(file.content).toContain("bob — APPROVED")
    expect(file.content).toContain("coderabbitai (bot)")
    expect(file.content).toContain("`src/http/createUser.ts:18`")

    const parsed = parseGithubPullRequestMarkdown(file.content)
    expect(parsed).toMatchObject({
      id: 987654,
      number: 42,
      repository: "acme/api",
      url: "https://github.com/acme/api/pull/42",
      title: "Reject god objects in handlers",
      state: "closed",
      merged: true,
      reviewDecision: "APPROVED",
      files: [
        { path: "src/http/createUser.ts", status: "modified" },
        { path: "src/domain/user.ts", status: "added" },
        { path: "src/legacy.ts", status: "removed" },
        {
          path: "src/users/service.ts",
          status: "renamed",
          previousPath: "src/userService.ts",
        },
      ],
    })
  })
})

describe("github pull request mirror paths", () => {
  it("uses owner/repo/number--id under github/pulls", () => {
    expect(githubPullRequestMarkdownPath("acme/api", 7, 99)).toBe(
      "github/pulls/acme/api/7--99.md",
    )
  })

  it("recognises mirrored pull request files and the config yaml", () => {
    expect(
      isGithubPullRequestMirrorPath("github/pulls/acme/api/42--1.md"),
    ).toBe(true)
    expect(isGithubPullRequestMirrorPath("github/config.yaml")).toBe(true)
    expect(isGithubPullRequestMirrorPath("linear/issues/foo--1.md")).toBe(false)
  })
})
