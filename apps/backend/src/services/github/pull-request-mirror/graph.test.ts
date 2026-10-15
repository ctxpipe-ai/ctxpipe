import { describe, expect, it } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import {
  parseGithubPullRequestMarkdown,
  renderGithubPullRequest,
} from "./converter.js"
import {
  buildGithubPullRequestGraph,
  linearIssueIdentifiersForPullRequest,
} from "./graph.js"
import type { GithubPullRequestSnapshot } from "./types.js"

const snapshot: GithubPullRequestSnapshot = {
  id: 10,
  number: 8,
  repository: "acme/api",
  url: "https://github.com/acme/api/pull/8",
  title: "ENG-123 Split user create",
  body: "Move logic out of the handler.\n\nCloses https://linear.app/acme/issue/OPS-4/rotate-keys",
  state: "closed",
  merged: true,
  draft: false,
  author: { login: "alice", type: "human" },
  base: { ref: "main", sha: "aaa" },
  head: { ref: "alice/eng-123-split-user-create", sha: "bbb" },
  reviewDecision: "APPROVED",
  labels: [],
  requestedReviewers: [],
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-02T00:00:00.000Z",
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
  reviews: [],
  comments: [],
  requiredChecks: [],
}

function parsed() {
  const file = renderGithubPullRequest(snapshot)
  const result = parseGithubPullRequestMarkdown(file.content)
  if (!result) throw new Error("expected frontmatter to parse")
  return { file, result }
}

describe("buildGithubPullRequestGraph", () => {
  it("emits typed change edges dated at merge, TARGETS the source repository, and a neutral File", () => {
    const { file, result } = parsed()
    const { extractedObjects, extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
    })

    expect(extractedObjects.map((object) => object.kind).sort()).toEqual([
      "File",
      "File",
      "File",
      "File",
      "PullRequest",
    ])
    const pull = extractedObjects.find(
      (object) => object.kind === "PullRequest",
    )
    expect(pull?.payload).toMatchObject({
      number: 8,
      merged_at: "2026-03-02T11:00:00.000Z",
      author: "alice",
      excerpt: expect.stringContaining("Move logic out of the handler."),
    })
    const removedFile = extractedObjects.find(
      (object) => object.name === "src/legacy.ts",
    )
    expect(removedFile?.summary).toBe("File at src/legacy.ts")
    expect(removedFile?.payload).toEqual({
      path: "src/legacy.ts",
      repository: "acme/api",
    })

    const changes = extractedClaims.filter((claim) =>
      ["ADDED", "MODIFIED", "REMOVED", "RENAMED"].includes(claim.predicate),
    )
    expect(
      changes.map((claim) => [claim.predicate, claim.provenance?.file]),
    ).toEqual([
      ["MODIFIED", "src/http/createUser.ts"],
      ["ADDED", "src/domain/user.ts"],
      ["REMOVED", "src/legacy.ts"],
      ["RENAMED", "src/users/service.ts"],
    ])
    for (const claim of changes) expect(claim.validFrom).toBe("2026-03-02")

    const targets = extractedClaims.find(
      (claim) => claim.predicate === "TARGETS",
    )
    expect(targets).toMatchObject({
      subjectKind: "PullRequest",
      objectRef: "repo_api",
      validFrom: "2026-03-02",
    })
    expect(extractedClaims.some((claim) => claim.predicate === "ABOUT")).toBe(
      false,
    )
  })

  it("asserts containment only for paths still present, on repository and package", () => {
    const { file, result } = parsed()
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
      packageRoots: [
        {
          kind: "Service",
          repositoryId: "repo_api",
          root: "src",
          deduplicationKey: "svc:repo_api:src",
        },
      ],
    })
    const partOf = extractedClaims.filter(
      (claim) => claim.predicate === "PART_OF",
    )
    expect(
      partOf.filter((claim) => claim.objectKind === "Repository"),
    ).toHaveLength(3)
    expect(
      partOf.filter((claim) => claim.objectRef === "svc:repo_api:src"),
    ).toHaveLength(3)
    expect(
      partOf.some((claim) => claim.provenance?.file === "src/legacy.ts"),
    ).toBe(false)
  })

  it("uses convention-shaped evidence ids carrying both repository ids and the warehouse path", () => {
    const { file, result } = parsed()
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
    })
    for (const claim of extractedClaims) {
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_ctx", "abc123"),
      ).toBe(true)
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_api", "abc123"),
      ).toBe(true)
      expect(claim.sourceId.split(":")).toContain(file.path)
    }
  })

  it("references Linear issues from URLs, title and branch, restricted to known team keys", () => {
    const { file, result } = parsed()
    expect(linearIssueIdentifiersForPullRequest(result, ["ENG"])).toEqual([
      "OPS-4",
      "ENG-123",
    ])
    expect(linearIssueIdentifiersForPullRequest(result, [])).toEqual(["OPS-4"])

    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
      linearTeamKeys: ["ENG"],
    })
    expect(
      extractedClaims
        .filter((claim) => ["REFERENCES", "RESOLVES"].includes(claim.predicate))
        .map((claim) => claim.objectRef)
        .sort(),
    ).toEqual(["iss:linear:ENG-123", "iss:linear:OPS-4"])
  })

  it("resolves an issue that a merged pull request closes by keyword or branch, and references the others", () => {
    const file = renderGithubPullRequest({
      ...snapshot,
      title: "Fix: ENG-7 and tidy ENG-8",
      head: { ref: "alice/eng-9-retry", sha: "bbb" },
      body: [
        "Closes https://linear.app/acme/issue/OPS-4/rotate-keys.",
        "resolves ENG-10, see ENG-11 and https://linear.app/acme/issue/OPS-5.",
        "COMPLETED:ENG-13",
        "A prefix ENG-14 is not a keyword; the fixes for ENG-12 come later.",
      ].join("\n"),
    })
    const result = parseGithubPullRequestMarkdown(file.content)
    if (!result) throw new Error("expected frontmatter to parse")
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
      linearTeamKeys: ["ENG"],
    })
    const byPredicate = (predicate: string) =>
      extractedClaims
        .filter((claim) => claim.predicate === predicate)
        .map((claim) => claim.objectRef.replace("iss:linear:", ""))
        .sort()
    expect(byPredicate("RESOLVES")).toEqual([
      "ENG-10",
      "ENG-13",
      "ENG-7",
      "ENG-9",
      "OPS-4",
    ])
    expect(byPredicate("REFERENCES")).toEqual([
      "ENG-11",
      "ENG-12",
      "ENG-14",
      "ENG-8",
      "OPS-5",
    ])
    const resolves = extractedClaims.find(
      (claim) => claim.predicate === "RESOLVES",
    )
    expect(resolves).toMatchObject({
      subjectKind: "PullRequest",
      objectKind: "Issue",
      validFrom: "2026-03-02",
    })
  })

  it("resolves an issue whose identifier or URL is wrapped in a Markdown link or code span", () => {
    const file = renderGithubPullRequest({
      ...snapshot,
      title: "Retry imports",
      head: { ref: "alice/retry", sha: "bbb" },
      body: [
        "Fixes [ENG-21](https://linear.app/acme/issue/ENG-21/retry)",
        "Closes `ENG-22`",
        "Resolves [the issue](https://linear.app/acme/issue/ENG-23)",
        "See `ENG-24`",
      ].join("\n"),
    })
    const result = parseGithubPullRequestMarkdown(file.content)
    if (!result) throw new Error("expected frontmatter to parse")
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      linearTeamKeys: ["ENG"],
    })
    const byPredicate = (predicate: string) =>
      extractedClaims
        .filter((claim) => claim.predicate === predicate)
        .map((claim) => claim.objectRef.replace("iss:linear:", ""))
        .sort()
    expect(byPredicate("RESOLVES")).toEqual(["ENG-21", "ENG-22"])
    expect(byPredicate("REFERENCES")).toEqual(["ENG-23", "ENG-24"])
  })

  it("only references issues from a revert pull request, whatever its title or branch says", () => {
    for (const revert of [
      { title: 'Revert "Fixes ENG-9 retry"', ref: "alice/eng-9-retry" },
      {
        title: "Undo the retry, fixes ENG-9",
        ref: "revert-8-alice/eng-9-retry",
      },
    ]) {
      const file = renderGithubPullRequest({
        ...snapshot,
        title: revert.title,
        head: { ref: revert.ref, sha: "bbb" },
        body: "",
      })
      const result = parseGithubPullRequestMarkdown(file.content)
      if (!result) throw new Error("expected frontmatter to parse")
      const { extractedClaims } = buildGithubPullRequestGraph({
        parsed: result,
        markdownPath: file.path,
        targetHash: "abc123",
        contextRepositoryId: "repo_ctx",
        linearTeamKeys: ["ENG"],
      })
      expect(
        extractedClaims
          .filter((claim) => claim.objectKind === "Issue")
          .map((claim) => [claim.predicate, claim.objectRef]),
      ).toEqual([["REFERENCES", "iss:linear:ENG-9"]])
    }
  })

  it("reads issue ids from the whole description, past the 2,000-character excerpt", () => {
    const file = renderGithubPullRequest({
      ...snapshot,
      title: "Split user create",
      head: { ref: "alice/split-user-create", sha: "bbb" },
      body: `${"Context line.\n".repeat(200)}\nFixes ENG-30. See ENG-31.`,
    })
    const result = parseGithubPullRequestMarkdown(file.content)
    if (!result) throw new Error("expected frontmatter to parse")
    expect(result.bodyExcerpt.length).toBeLessThanOrEqual(2_000)
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      linearTeamKeys: ["ENG"],
    })
    expect(
      extractedClaims
        .filter((claim) => claim.objectKind === "Issue")
        .map((claim) => `${claim.predicate} ${claim.objectRef}`)
        .sort(),
    ).toEqual(["REFERENCES iss:linear:ENG-31", "RESOLVES iss:linear:ENG-30"])
  })

  it("only references issues from a pull request closed without a merge, even with a closing keyword", () => {
    const file = renderGithubPullRequest({
      ...snapshot,
      merged: false,
      mergedAt: null,
    })
    const result = parseGithubPullRequestMarkdown(file.content)
    if (!result) throw new Error("expected frontmatter to parse")
    const { extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      linearTeamKeys: ["ENG"],
    })
    expect(extractedClaims.map((claim) => claim.predicate)).toEqual([
      "REFERENCES",
      "REFERENCES",
    ])
  })

  it("keeps only the pull request, its repository and its issue references when it closed without a merge", () => {
    const file = renderGithubPullRequest({
      ...snapshot,
      merged: false,
      mergedAt: null,
    })
    const result = parseGithubPullRequestMarkdown(file.content)
    if (!result) throw new Error("expected frontmatter to parse")
    const { extractedObjects, extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
      sourceRepositoryId: "repo_api",
      linearTeamKeys: ["ENG"],
    })
    expect(extractedObjects.map((object) => object.kind)).toEqual([
      "PullRequest",
    ])
    expect(extractedObjects[0]?.payload).toMatchObject({
      state: "closed",
      merged: false,
      merged_at: null,
    })
    expect(
      extractedClaims.map((claim) => [claim.predicate, claim.objectRef]).sort(),
    ).toEqual([
      ["REFERENCES", "iss:linear:ENG-123"],
      ["REFERENCES", "iss:linear:OPS-4"],
      ["TARGETS", "repo_api"],
    ])
  })

  it("falls back to name-scoped keys and skips TARGETS when the source repository is unknown", () => {
    const { file, result } = parsed()
    const { extractedObjects, extractedClaims } = buildGithubPullRequestGraph({
      parsed: result,
      markdownPath: file.path,
      targetHash: "abc123",
      contextRepositoryId: "repo_ctx",
    })
    expect(extractedObjects[0]?.deduplicationKey).toBe("prq:github:acme/api:8")
    expect(extractedClaims.some((claim) => claim.predicate === "TARGETS")).toBe(
      false,
    )
    expect(extractedClaims.some((claim) => claim.predicate === "PART_OF")).toBe(
      false,
    )
    expect(
      extractedClaims.filter((claim) => claim.predicate === "MODIFIED"),
    ).toHaveLength(1)
  })
})
