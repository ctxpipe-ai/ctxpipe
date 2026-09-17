import { describe, expect, it } from "vitest"
import {
  extractBacktickedPaths,
  extractUrls,
  findAdrReferences,
  findLinearIdentifiers,
  githubTeamDedupKey,
  isoDateOf,
  issueDedupKey,
  parseGithubPullRequestUrl,
  parseGithubTeamOwner,
  parseLinearIssueUrl,
  parseSlackPermalink,
  pullRequestDedupKey,
  threadDedupKey,
} from "./referenceResolver.js"

describe("GitHub pull request references", () => {
  it("parses pull URLs and ignores issues, commits and other hosts", () => {
    expect(
      parseGithubPullRequestUrl("https://github.com/acme/api/pull/42"),
    ).toEqual({
      owner: "acme",
      repo: "api",
      repository: "acme/api",
      number: 42,
    })
    expect(
      parseGithubPullRequestUrl(
        "https://github.com/acme/api/pull/42/files#diff-1",
      ),
    ).toMatchObject({ number: 42 })
    expect(
      parseGithubPullRequestUrl("https://github.com/acme/api/issues/42"),
    ).toBeNull()
    expect(
      parseGithubPullRequestUrl("https://github.com/acme/api/commit/abc"),
    ).toBeNull()
    expect(
      parseGithubPullRequestUrl(
        "https://gitlab.com/acme/api/-/merge_requests/1",
      ),
    ).toBeNull()
    expect(parseGithubPullRequestUrl("not a url")).toBeNull()
  })

  it("keys pull requests by source repository id, else by GitHub name", () => {
    expect(
      pullRequestDedupKey({
        sourceRepositoryId: "repo_api",
        repository: "acme/api",
        number: 42,
      }),
    ).toBe("prq:repo_api:42")
    expect(pullRequestDedupKey({ repository: "acme/api", number: 42 })).toBe(
      "prq:github:acme/api:42",
    )
  })
})

describe("Linear references", () => {
  it("parses issue URLs and normalizes identifiers", () => {
    expect(
      parseLinearIssueUrl(
        "https://linear.app/acme/issue/ENG-123/split-user-create",
      ),
    ).toBe("ENG-123")
    expect(
      parseLinearIssueUrl("https://linear.app/acme/project/auth-cleanup-abc"),
    ).toBeNull()
    expect(issueDedupKey("eng-123")).toBe("iss:linear:ENG-123")
    expect(() => issueDedupKey("UTF-8 text")).toThrow()
  })

  it("finds bare identifiers only for known team keys", () => {
    const text =
      "Fixes ENG-123 and eng-7; see UTF-8, SHA-256 and ISO-8601. Also OPS-9."
    expect(findLinearIdentifiers(text, ["ENG", "ops"])).toEqual([
      "ENG-123",
      "ENG-7",
      "OPS-9",
    ])
    expect(findLinearIdentifiers(text, [])).toEqual([])
    expect(findLinearIdentifiers(text, ["UTF"])).toEqual(["UTF-8"])
  })
})

describe("team, thread and decision keys", () => {
  it("parses CODEOWNERS team owners and skips individual users", () => {
    expect(parseGithubTeamOwner("@acme/backend")).toBe(
      "team:github:acme/backend",
    )
    expect(parseGithubTeamOwner("@alice")).toBeNull()
    expect(parseGithubTeamOwner("alice@example.com")).toBeNull()
    expect(githubTeamDedupKey("Acme", "Backend")).toBe(
      "team:github:acme/backend",
    )
  })

  it("parses Slack permalinks, preferring thread_ts", () => {
    expect(
      parseSlackPermalink(
        "https://acme.slack.com/archives/C0123ABC/p1709372400123456",
      ),
    ).toEqual({ channelId: "C0123ABC", ts: "1709372400.123456" })
    expect(
      parseSlackPermalink(
        "https://acme.slack.com/archives/C0123ABC/p1709372500000001?thread_ts=1709372400.123456&cid=C0123ABC",
      ),
    ).toEqual({ channelId: "C0123ABC", ts: "1709372400.123456" })
    expect(
      parseSlackPermalink("https://acme.slack.com/messages/C0123ABC"),
    ).toBeNull()
    expect(threadDedupKey("C0123ABC", "1709372400.123456")).toBe(
      "thr:slack:C0123ABC:1709372400.123456",
    )
  })

  it("finds ADR references in prose", () => {
    expect(
      findAdrReferences("Supersedes ADR-031 and adr 0007; not ADRX-1."),
    ).toEqual(["ADR-31", "ADR-7"])
  })
})

describe("text scanners", () => {
  it("extracts urls and trims trailing punctuation", () => {
    expect(
      extractUrls(
        "See https://github.com/acme/api/pull/42, and (https://linear.app/acme/issue/ENG-1).",
      ),
    ).toEqual([
      "https://github.com/acme/api/pull/42",
      "https://linear.app/acme/issue/ENG-1",
    ])
  })

  it("extracts backticked repo paths only", () => {
    expect(
      extractBacktickedPaths(
        "Edit `apps/backend/src/x.ts` and `./docs/adr/0007-x.md`, not `pnpm`, `/etc/hosts`, `../x.ts` or `https://a.b/c.md`.",
      ),
    ).toEqual(["apps/backend/src/x.ts", "docs/adr/0007-x.md"])
  })

  it("derives ISO dates for validity", () => {
    expect(isoDateOf("2026-03-02T11:00:00.000Z")).toBe("2026-03-02")
    expect(isoDateOf(null)).toBeUndefined()
    expect(isoDateOf("nope")).toBeUndefined()
  })
})
