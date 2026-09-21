import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  loadConfig: vi.fn(),
  patchMirror: vi.fn(),
  runIngestion: vi.fn(),
  syncPullRequests: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, handler: () => Promise<unknown>) =>
    handler(),
}))
vi.mock("../../models/github-pr-mirror.js", () => ({
  getGithubPrMirrorBinding: mocks.getBinding,
  patchGithubPrMirror: mocks.patchMirror,
}))
vi.mock("../../observability/logger.js", () => ({
  createLogger: vi.fn(() => ({})),
  getLogger: vi.fn(() => ({ error: vi.fn() })),
  withLogger: (_logger: unknown, handler: () => Promise<unknown>) => handler(),
}))
vi.mock(
  "../../services/github/pull-request-mirror/config-from-repo.js",
  () => ({
    loadGithubPrMirrorConfigFromRepo: mocks.loadConfig,
  }),
)
vi.mock("../../services/github/pull-request-mirror/sync.js", () => ({
  syncGithubPullRequestsForConfig: mocks.syncPullRequests,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import {
  githubPrMirrorContentIdempotencyKey,
  githubSyncContent,
} from "./github-sync-content.js"

describe("githubSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBinding.mockResolvedValue({
      enabled: true,
      repositoryId: "repo_ctx",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    mocks.syncPullRequests.mockResolvedValue({
      written: 1,
      failedRepositories: [],
    })
    mocks.runIngestion.mockResolvedValue(undefined)
    mocks.patchMirror.mockResolvedValue(undefined)
  })

  it("keys a content sync by connection and config commit", () => {
    expect(
      githubPrMirrorContentIdempotencyKey({
        connectionId: "con_github",
        commitSha: "sha_config",
      }),
    ).toBe("github-pr-mirror-content:con_github:sha_config")
  })

  it("hands repository ingestion an explicit workflow logger", async () => {
    const stepRun = vi.fn(
      async (_options: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    )

    await githubSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_github" },
      step: { run: stepRun },
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repositoryId: "repo_ctx" }),
      expect.objectContaining({ error: expect.any(Function) }),
    )
    expect(mocks.patchMirror).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patch: {
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          enabled: true,
        },
      }),
    )
  })

  it("does not mark OpenWorkflow suspension as a failed sync", async () => {
    const sleepSignal = new Error("suspend")
    sleepSignal.name = "SleepSignal"
    mocks.runIngestion.mockRejectedValueOnce(sleepSignal)
    const stepRun = vi.fn(
      async (_options: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    )

    await expect(
      githubSyncContent.fn({
        input: { orgId: "org_1", connectionId: "con_github" },
        step: { run: stepRun },
      } as never),
    ).rejects.toBe(sleepSignal)

    expect(mocks.patchMirror).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })
})
