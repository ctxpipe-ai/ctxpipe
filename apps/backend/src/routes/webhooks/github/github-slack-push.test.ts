import { beforeEach, describe, expect, it, vi } from "vitest"

const enqueueMock = vi.hoisted(() => vi.fn())
const loadScopeMock = vi.hoisted(() => vi.fn())
const resetMock = vi.hoisted(() => vi.fn())

vi.mock("../../../config/env.js", () => ({
  parseEnv: () => ({}),
}))
vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: vi.fn(),
}))
vi.mock("../../../models/slack-connector.js", () => ({
  listSlackSyncTargetsWithRepoByRepositoryId: vi.fn(),
  resetSlackConnectorAfterMissingConfig: resetMock,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: vi.fn(),
}))
vi.mock("../../../openworkflow/enqueue-slack-push-sync.js", () => ({
  enqueueSlackFullSyncAfterConfigPush: enqueueMock,
}))
vi.mock("../../../services/slack/config-from-repo.js", () => ({
  SLACK_CONFIG_PATH: "slack/config.yaml",
  loadSlackScopeFromRepo: loadScopeMock,
}))
vi.mock("../../../services/github/installation-write-client.js", () => ({
  compareCommitsTouchesPath: vi.fn(),
}))

import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { listSlackSyncTargetsWithRepoByRepositoryId } from "../../../models/slack-connector.js"
import { maybeEnqueueSlackSyncOnConfigPush } from "./github-slack-push.js"

describe("maybeEnqueueSlackSyncOnConfigPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listInstallationsByGithubInstallationId).mockResolvedValue([
      { id: "ghc_1", orgId: "org_1", installationId: 42 },
    ] as never)
    vi.mocked(findRepositoryByGithubInstallation).mockResolvedValue({
      id: "repo_1",
      name: "acme/docs",
      githubConnectionId: "ghc_1",
    } as never)
    vi.mocked(listSlackSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_1",
        branch: "main",
        githubConnectionId: "ghc_1",
        repositoryName: "acme/docs",
      },
    ] as never)
    loadScopeMock.mockResolvedValue({
      oldestDays: 90,
      channels: [{ channelId: "C1", name: "eng", isPrivate: false }],
    })
    enqueueMock.mockResolvedValue(undefined)
    resetMock.mockResolvedValue(undefined)
  })

  it("starts content sync when slack/config.yaml is merged", async () => {
    await maybeEnqueueSlackSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      commits: [{ modified: ["slack/config.yaml"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_1",
      }),
    )
    expect(resetMock).not.toHaveBeenCalled()
  })

  it("limits processing to the authenticated GitHub connection", async () => {
    vi.mocked(listInstallationsByGithubInstallationId).mockResolvedValue([
      { id: "ghc_1", orgId: "org_1", installationId: 42 },
      { id: "ghc_2", orgId: "org_2", installationId: 42 },
    ] as never)
    vi.mocked(findRepositoryByGithubInstallation).mockResolvedValue({
      id: "repo_2",
      name: "acme/docs",
      githubConnectionId: "ghc_2",
    } as never)
    vi.mocked(listSlackSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_2",
        connectionId: "con_2",
        branch: "main",
        githubConnectionId: "ghc_2",
        repositoryName: "acme/docs",
      },
    ] as never)

    await maybeEnqueueSlackSyncOnConfigPush({
      installationId: 42,
      githubConnectionId: "ghc_2",
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      commits: [{ modified: ["slack/config.yaml"] }],
      log: { error: vi.fn() },
    })

    expect(findRepositoryByGithubInstallation).toHaveBeenCalledOnce()
    expect(findRepositoryByGithubInstallation).toHaveBeenCalledWith(
      "org_2",
      "acme/docs",
      "ghc_2",
    )
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_2", connectionId: "con_2" }),
    )
  })

  it("returns the connector to draft when the config is removed", async () => {
    loadScopeMock.mockResolvedValue(undefined)

    await maybeEnqueueSlackSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/main",
      commits: [{ removed: ["slack/config.yaml"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(resetMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_1",
    })
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("starts content sync on a configured non-default target branch", async () => {
    vi.mocked(listSlackSyncTargetsWithRepoByRepositoryId).mockResolvedValue([
      {
        orgId: "org_1",
        connectionId: "con_1",
        branch: "release/docs",
        githubConnectionId: "ghc_1",
        repositoryName: "acme/docs",
      },
    ] as never)

    await maybeEnqueueSlackSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/release/docs",
      commits: [{ modified: ["slack/config.yaml"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(loadScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "release/docs" }),
    )
    expect(enqueueMock).toHaveBeenCalledOnce()
  })

  it("ignores a push that does not match the configured target branch", async () => {
    await maybeEnqueueSlackSyncOnConfigPush({
      installationId: 42,
      repoFullName: "acme/docs",
      ref: "refs/heads/feature",
      commits: [{ modified: ["slack/config.yaml"] }],
      before: "aaa",
      after: "bbb",
      log: { error: vi.fn() },
    })

    expect(loadScopeMock).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })
})
