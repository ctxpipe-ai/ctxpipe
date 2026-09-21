import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  loadConfig: vi.fn(),
  syncPullRequest: vi.fn(),
  runIngestion: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../models/github-pr-mirror.js", () => ({
  getGithubPrMirrorBinding: mocks.getBinding,
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
  syncGithubPullRequestToGit: mocks.syncPullRequest,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { githubSyncPullRequest } from "./github-sync-pull-request.js"

const yamlConfig = {
  repositories: ["acme/api"],
  states: ["merged"],
  includeDrafts: false,
  maxPullRequestsPerRepository: 100,
}

describe("githubSyncPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBinding.mockResolvedValue({
      enabled: true,
      setupPhase: "live",
      repositoryId: "repo_ctx",
      repositoryName: "acme/ctx",
      githubConnectionId: "con_gh",
      branch: "main",
    })
    mocks.loadConfig.mockResolvedValue(yamlConfig)
    mocks.syncPullRequest.mockResolvedValue({ written: false })
    mocks.runIngestion.mockResolvedValue(undefined)
  })

  it("skips the GitHub snapshot when issue_comment is for a repo outside yaml", async () => {
    const stepRun = vi.fn(
      async (_options: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    )

    const result = await githubSyncPullRequest.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_gh",
        sourceRepository: "acme/docs-only",
        number: 7,
      },
      step: { run: stepRun },
    } as never)

    expect(result).toEqual({ written: false, skipped: "policy" })
    expect(mocks.syncPullRequest).not.toHaveBeenCalled()
    expect(stepRun.mock.calls.map(([options]) => options.name)).toEqual([
      "load-github-pr-entity-context",
    ])
  })

  it("fetches a snapshot only after the repo-in-yaml check passes", async () => {
    const stepRun = vi.fn(
      async (_options: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    )
    mocks.syncPullRequest.mockResolvedValue({
      written: true,
      path: "github/pulls/acme/api/7--7.md",
    })

    await githubSyncPullRequest.fn({
      input: {
        orgId: "org_1",
        connectionId: "con_gh",
        sourceRepository: "acme/api",
        number: 7,
      },
      step: { run: stepRun },
    } as never)

    expect(mocks.syncPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRepository: "acme/api",
        number: 7,
      }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repositoryId: "repo_ctx" }),
      expect.objectContaining({ error: expect.any(Function) }),
    )
  })
})
