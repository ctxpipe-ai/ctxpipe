import { describe, expect, it } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { GithubIssueSnapshot } from "../../../services/github/issue-mirror/client.js"
import {
  parseGithubIssueMarkdown,
  renderGithubIssue,
} from "../../../services/github/issue-mirror/converter.js"
import { buildGithubIssueGraph } from "./extractGithubIssues.js"

const issue: GithubIssueSnapshot = {
  id: "I_kwDOA1",
  number: 12,
  repository: "acme/api",
  url: "https://github.com/acme/api/issues/12",
  title: "Login fails behind the proxy",
  body: "Steps:\n\n1. Sign in\n2. See a 502",
  state: "closed",
  stateReason: "completed",
  author: { login: "alice", type: "human" },
  labels: ["bug"],
  assignees: ["bob"],
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-03T00:00:00Z",
  closedAt: "2026-03-03T00:00:00Z",
  comments: [
    {
      author: { login: "ci", type: "bot" },
      body: "Reproduced on main.",
      createdAt: "2026-03-02T00:00:00Z",
    },
  ],
}

describe("GitHub issue mirror round trip", () => {
  it("renders readable Markdown at a number-keyed path", () => {
    const file = renderGithubIssue(issue)
    expect(file.path).toBe("github/issues/acme/api/12.md")
    expect(file.content).toContain("# Login fails behind the proxy")
    expect(file.content).toContain("1. Sign in\n2. See a 502")
    expect(file.content).toContain(
      "## Comments\n\n### 2026-03-02T00:00:00Z · ci (bot)\n\nReproduced on main.",
    )
  })

  it("parses the frontmatter back and keeps comments out of the excerpt", () => {
    const parsed = parseGithubIssueMarkdown(renderGithubIssue(issue).content)
    expect(parsed).toEqual({
      number: 12,
      repository: "acme/api",
      url: "https://github.com/acme/api/issues/12",
      title: "Login fails behind the proxy",
      state: "closed",
      stateReason: "completed",
      author: "alice",
      labels: ["bug"],
      assignees: ["bob"],
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-03T00:00:00Z",
      closedAt: "2026-03-03T00:00:00Z",
      excerpt: "Steps:\n\n1. Sign in\n2. See a 502",
    })
    expect(parseGithubIssueMarkdown("---\nsource: linear\n---\n")).toBeNull()
  })

  it("extracts an Issue PART_OF its source repository", () => {
    const file = renderGithubIssue(issue)
    const parsed = parseGithubIssueMarkdown(file.content)
    if (!parsed) throw new Error("expected frontmatter to parse")
    const graph = buildGithubIssueGraph({
      parsed,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
    })

    expect(graph.extractedObjects).toEqual([
      expect.objectContaining({
        kind: "Issue",
        deduplicationKey: "iss:repo_api:12",
        name: "acme/api#12: Login fails behind the proxy",
      }),
    ])
    expect(graph.extractedClaims).toEqual([
      expect.objectContaining({
        subjectRef: "iss:repo_api:12",
        predicate: "PART_OF",
        objectRef: "repo_api",
        objectKind: "Repository",
        extractionMethod: "deterministic",
      }),
    ])
    const sourceId = graph.extractedClaims[0]?.sourceId ?? ""
    expect(isConventionalEvidenceSourceId(sourceId, "repo_ctx", "abc123")).toBe(
      true,
    )
    expect(sourceId).toContain(
      ":repo_ctx:repo_api:github/issues/acme/api/12.md:",
    )
  })
})
