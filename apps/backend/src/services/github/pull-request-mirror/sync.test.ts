import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"
import type { GithubPullRequestSnapshot } from "./types.js"

const mocks = vi.hoisted(() => ({
  getInstallationOctokitForOrg: vi.fn(),
  commitFiles: vi.fn(),
  createPullRequestWithFiles: vi.fn(),
  fetchGithubPullRequestSnapshot: vi.fn(),
  listMergedPullRequestNumbers: vi.fn(),
}))

vi.mock("../../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: mocks.getInstallationOctokitForOrg,
}))
vi.mock("../installation-write-client.js", () => ({
  commitFiles: mocks.commitFiles,
  createPullRequestWithFiles: mocks.createPullRequestWithFiles,
}))
vi.mock("./client.js", () => ({
  fetchGithubPullRequestSnapshot: mocks.fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers: mocks.listMergedPullRequestNumbers,
}))

import {
  GITHUB_PR_MIRROR_COMMIT_BATCH,
  reviewDecisionFromReviews,
  syncGithubPullRequestsForConfig,
} from "./sync.js"

const review = (login: string, state: string, submittedAt: string) => ({
  author: { login, type: "human" as const },
  state,
  submittedAt,
})

describe("reviewDecisionFromReviews", () => {
  it("uses each reviewer's latest approval or change request", () => {
    expect(
      reviewDecisionFromReviews([
        review("bob", "CHANGES_REQUESTED", "2026-03-01T10:00:00Z"),
        review("bob", "APPROVED", "2026-03-02T10:00:00Z"),
      ]),
    ).toBe("APPROVED")
    expect(
      reviewDecisionFromReviews([
        review("bob", "APPROVED", "2026-03-01T10:00:00Z"),
        review("carol", "CHANGES_REQUESTED", "2026-03-02T10:00:00Z"),
      ]),
    ).toBe("CHANGES_REQUESTED")
  })

  it("ignores comments, dismissed and pending reviews", () => {
    expect(
      reviewDecisionFromReviews([
        review("bob", "COMMENTED", "2026-03-01T10:00:00Z"),
        review("bot", "DISMISSED", "2026-03-01T11:00:00Z"),
        review("dan", "PENDING", "2026-03-01T12:00:00Z"),
      ]),
    ).toBeNull()
    expect(reviewDecisionFromReviews([])).toBeNull()
  })
})

function snapshot(number: number): GithubPullRequestSnapshot {
  return {
    id: number * 10,
    number,
    repository: "acme/api",
    url: `https://github.com/acme/api/pull/${number}`,
    title: `PR ${number}`,
    body: "",
    state: "closed",
    merged: true,
    draft: false,
    author: { login: "alice", type: "human" },
    base: { ref: "main", sha: "a" },
    head: { ref: "f", sha: "b" },
    reviewDecision: null,
    labels: [],
    requestedReviewers: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    mergedAt: "2026-03-02T00:00:00.000Z",
    files: [],
    reviews: [],
    comments: [],
    requiredChecks: [],
  }
}

const binding: GithubPrMirrorBinding = {
  connectionId: "con_gh",
  orgId: "org_1",
  repositoryId: "repo_ctx",
  repositoryName: "acme/ctx",
  gitUrl: "https://github.com/acme/ctx.git",
  githubConnectionId: "con_gh",
  branch: "main",
  enabled: true,
  setupPhase: "initial_sync",
  pendingConfigPullUrl: null,
}

const config: GithubPrMirrorRepoConfig = {
  repositories: ["acme/api", "acme/broken"],
  states: ["merged"],
  includeDrafts: false,
  maxPullRequestsPerRepository: 500,
}

describe("syncGithubPullRequestsForConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getInstallationOctokitForOrg.mockResolvedValue({ octokit: {} })
    mocks.commitFiles.mockResolvedValue({
      commitSha: "c",
      branch: "main",
      installationId: 1,
    })
    mocks.fetchGithubPullRequestSnapshot.mockImplementation(
      async ({ number }: { number: number }) => snapshot(number),
    )
  })

  it("batches rendered pull requests into a bounded number of commits and isolates repository failures", async () => {
    const count = GITHUB_PR_MIRROR_COMMIT_BATCH + 5
    mocks.listMergedPullRequestNumbers.mockImplementation(
      async ({ repo }: { repo: string }) => {
        if (repo === "broken") throw new Error("404 not found")
        return Array.from({ length: count }, (_, i) => i + 1)
      },
    )
    const log = { error: vi.fn() }

    const result = await syncGithubPullRequestsForConfig({
      orgId: "org_1",
      env: {} as never,
      binding,
      config,
      log,
    })

    expect(result).toEqual({
      written: count,
      failedRepositories: ["acme/broken"],
    })
    expect(mocks.commitFiles).toHaveBeenCalledTimes(2)
    expect(mocks.commitFiles.mock.calls[0]?.[0].files).toHaveLength(
      GITHUB_PR_MIRROR_COMMIT_BATCH,
    )
    expect(mocks.commitFiles.mock.calls[1]?.[0].files).toHaveLength(5)
    expect(mocks.commitFiles.mock.calls[0]?.[0].message).toContain("acme/api")
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it("skips pull requests the scope policy excludes without committing", async () => {
    mocks.listMergedPullRequestNumbers.mockResolvedValue([1, 2])
    mocks.fetchGithubPullRequestSnapshot.mockImplementation(
      async ({ number }: { number: number }) => ({
        ...snapshot(number),
        merged: number === 1,
        state: number === 1 ? "closed" : "open",
      }),
    )
    const result = await syncGithubPullRequestsForConfig({
      orgId: "org_1",
      env: {} as never,
      binding,
      config: { ...config, repositories: ["acme/api"] },
      log: { error: vi.fn() },
    })
    expect(result.written).toBe(1)
    expect(mocks.commitFiles).toHaveBeenCalledTimes(1)
  })

  it("fails the backfill only when every repository failed", async () => {
    mocks.listMergedPullRequestNumbers.mockRejectedValue(new Error("boom"))
    await expect(
      syncGithubPullRequestsForConfig({
        orgId: "org_1",
        env: {} as never,
        binding,
        config,
        log: { error: vi.fn() },
      }),
    ).rejects.toThrow(/every repository/)
  })
})
