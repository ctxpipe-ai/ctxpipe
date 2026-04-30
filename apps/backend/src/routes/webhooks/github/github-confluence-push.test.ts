import { beforeEach, describe, expect, it, vi } from "vitest"

const enqueueMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const loadScopeMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    spaces: [{ spaceKey: "ENG", selectedPageIds: null }],
  }),
)
const compareCommitsTouchesPathMock = vi.hoisted(() => vi.fn())

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))

vi.mock("../../../models/confluence-sync-target.js", () => ({
  listConfluenceSyncTargetsWithRepoByRepositoryId: vi.fn(),
}))

vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: vi.fn(),
}))

vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: vi.fn(),
}))

vi.mock("../../../openworkflow/enqueue-confluence-push-sync.js", () => ({
  enqueueConfluenceFullSyncAfterConfigPush: enqueueMock,
  loadScopeForGithubPush: loadScopeMock,
}))

vi.mock("../../../services/github/installation-write-client.js", () => ({
  compareCommitsTouchesPath: compareCommitsTouchesPathMock,
}))

import { listConfluenceSyncTargetsWithRepoByRepositoryId } from "../../../models/confluence-sync-target.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { maybeEnqueueConfluenceSyncOnConfigPush } from "./github-confluence-push.js"

describe("maybeEnqueueConfluenceSyncOnConfigPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enqueueMock.mockResolvedValue(undefined)
    loadScopeMock.mockResolvedValue({
      spaces: [{ spaceKey: "ENG", selectedPageIds: null }],
    })
    compareCommitsTouchesPathMock.mockResolvedValue(false)
  })

  it("enqueues when commits list includes confluence/config.yaml", async () => {
    vi.mocked(listInstallationsByGithubInstallationId).mockResolvedValue([
      {
        id: "ghc_1",
        orgId: "org_1",
        installationId: 42,
      },
    ] as never)
    vi.mocked(findRepositoryByGithubInstallation).mockResolvedValue({
      id: "repo_1",
      name: "acme/docs",
      githubConnectionId: "ghc_1",
    } as never)
    vi.mocked(listConfluenceSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_1",
        branch: "main",
        githubConnectionId: "ghc_1",
        repositoryName: "acme/docs",
      },
    ] as never)

    await maybeEnqueueConfluenceSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      repository: { full_name: "acme/docs", default_branch: "main" },
      commits: [{ modified: ["confluence/config.yaml"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(enqueueMock.mock.calls[0]?.[0]?.connectionId).toBe("con_1")
    expect(compareCommitsTouchesPathMock).not.toHaveBeenCalled()
  })

  it("uses compareCommits fallback when commits omit file paths but before/after exist", async () => {
    vi.mocked(listInstallationsByGithubInstallationId).mockResolvedValue([
      {
        id: "ghc_1",
        orgId: "org_1",
        installationId: 42,
      },
    ] as never)
    vi.mocked(findRepositoryByGithubInstallation).mockResolvedValue({
      id: "repo_1",
      name: "acme/docs",
      githubConnectionId: "ghc_1",
    } as never)
    compareCommitsTouchesPathMock.mockResolvedValue(true)
    vi.mocked(listConfluenceSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_1",
        branch: "main",
        githubConnectionId: "ghc_1",
        repositoryName: "acme/docs",
      },
    ] as never)

    await maybeEnqueueConfluenceSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      repository: { full_name: "acme/docs", default_branch: "main" },
      commits: [{ modified: ["README.md"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(compareCommitsTouchesPathMock).toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("enqueues full reconcile when YAML has empty spaces", async () => {
    vi.mocked(listInstallationsByGithubInstallationId).mockResolvedValue([
      {
        id: "ghc_1",
        orgId: "org_1",
        installationId: 42,
      },
    ] as never)
    vi.mocked(findRepositoryByGithubInstallation).mockResolvedValue({
      id: "repo_1",
      name: "acme/docs",
      githubConnectionId: "ghc_1",
    } as never)
    vi.mocked(listConfluenceSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_1",
        branch: "main",
        githubConnectionId: "ghc_1",
        repositoryName: "acme/docs",
      },
    ] as never)
    loadScopeMock.mockResolvedValue({ spaces: [] })

    await maybeEnqueueConfluenceSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      repository: { full_name: "acme/docs", default_branch: "main" },
      commits: [{ modified: ["confluence/config.yaml"] }],
      log: { error: vi.fn() },
    })

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(enqueueMock.mock.calls[0]?.[0]?.scopeFromRepo).toEqual({ spaces: [] })
  })
})
