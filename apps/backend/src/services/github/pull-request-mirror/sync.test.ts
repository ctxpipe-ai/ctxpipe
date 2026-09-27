import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GithubPrMirrorBinding } from "../../../models/github-pr-mirror.js"
import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"
import type { GithubPullRequestSnapshot } from "./types.js"

const mocks = vi.hoisted(() => ({
  getInstallationOctokitForOrg: vi.fn(),
  commitFiles: vi.fn(),
  fetchGithubPullRequestSnapshot: vi.fn(),
  listMergedPullRequestNumbers: vi.fn(),
}))

vi.mock("../../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: mocks.getInstallationOctokitForOrg,
}))
vi.mock("../installation-write-client.js", () => ({
  commitFiles: mocks.commitFiles,
}))
vi.mock("./client.js", () => ({
  fetchGithubPullRequestSnapshot: mocks.fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers: mocks.listMergedPullRequestNumbers,
}))

import {
  GITHUB_PR_MIRROR_COMMIT_BATCH,
  captureGithubPullRequestsForConfig,
  listGithubPullRequestNumbersForConfig,
  reviewDecisionFromReviews,
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
  lastContentCommitSha: null,
  lastContentLaunchToken: null,
  contentSyncGeneration: 0,
}

const config: GithubPrMirrorRepoConfig = {
  repositories: ["acme/api", "acme/broken"],
  states: ["merged"],
  includeDrafts: false,
  maxPullRequestsPerRepository: 500,
}

describe("listGithubPullRequestNumbersForConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getInstallationOctokitForOrg.mockResolvedValue({ octokit: {} })
  })

  it("lists pull request numbers for one repository without dest-repo writes", async () => {
    const count = GITHUB_PR_MIRROR_COMMIT_BATCH + 5
    mocks.listMergedPullRequestNumbers.mockResolvedValue(
      Array.from({ length: count }, (_, i) => i + 1),
    )
    const result = await listGithubPullRequestNumbersForConfig({
      orgId: "org_1",
      env: {} as never,
      binding,
      config,
      repository: "acme/api",
    })

    expect(result.numbers).toEqual(Array.from({ length: count }, (_, i) => i + 1))
    expect(mocks.commitFiles).not.toHaveBeenCalled()
    expect(mocks.fetchGithubPullRequestSnapshot).not.toHaveBeenCalled()
    expect(mocks.getInstallationOctokitForOrg).toHaveBeenCalledWith(
      "org_1",
      {},
      "con_gh",
      expect.objectContaining({ repoFullName: "acme/api" }),
    )
    expect(mocks.listMergedPullRequestNumbers).toHaveBeenCalledWith(
      expect.objectContaining({ max: 500 }),
    )
  })

  it("throws when listing the repository pull requests fails", async () => {
    mocks.listMergedPullRequestNumbers.mockRejectedValue(new Error("boom"))
    await expect(
      listGithubPullRequestNumbersForConfig({
        orgId: "org_1",
        env: {} as never,
        binding,
        config,
        repository: "acme/api",
      }),
    ).rejects.toThrow("boom")
  })
})

describe("captureGithubPullRequestsForConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getInstallationOctokitForOrg.mockResolvedValue({ octokit: {} })
    mocks.fetchGithubPullRequestSnapshot.mockImplementation(
      async ({ number }: { number: number }) => snapshot(number),
    )
  })

  it("renders a bounded batch of pull requests without dest-repo writes", async () => {
    const result = await captureGithubPullRequestsForConfig({
      orgId: "org_1",
      env: {} as never,
      binding,
      config,
      repository: "acme/api",
      numbers: [1, 2, 3],
    })

    expect(result.files).toHaveLength(3)
    expect(result.files[0]?.path).toBe("github/pulls/acme/api/1--10.md")
    expect(result.files.at(-1)?.path).toBe("github/pulls/acme/api/3--30.md")
    expect(mocks.commitFiles).not.toHaveBeenCalled()
    expect(mocks.listMergedPullRequestNumbers).not.toHaveBeenCalled()
    expect(mocks.getInstallationOctokitForOrg).toHaveBeenCalledWith(
      "org_1",
      {},
      "con_gh",
      expect.objectContaining({ repoFullName: "acme/api" }),
    )
  })

  it("rejects a capture larger than the 200-file Git batch", async () => {
    await expect(
      captureGithubPullRequestsForConfig({
        orgId: "org_1",
        env: {} as never,
        binding,
        config,
        repository: "acme/api",
        numbers: Array.from(
          { length: GITHUB_PR_MIRROR_COMMIT_BATCH + 1 },
          (_, i) => i + 1,
        ),
      }),
    ).rejects.toThrow(/200/)
    expect(mocks.fetchGithubPullRequestSnapshot).not.toHaveBeenCalled()
  })

  it("skips pull requests the scope policy excludes without capturing them", async () => {
    mocks.fetchGithubPullRequestSnapshot.mockImplementation(
      async ({ number }: { number: number }) => ({
        ...snapshot(number),
        merged: number === 1,
        state: number === 1 ? "closed" : "open",
      }),
    )
    const result = await captureGithubPullRequestsForConfig({
      orgId: "org_1",
      env: {} as never,
      binding,
      config: { ...config, repositories: ["acme/api"] },
      repository: "acme/api",
      numbers: [1, 2],
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe("github/pulls/acme/api/1--10.md")
    expect(mocks.commitFiles).not.toHaveBeenCalled()
  })
})
