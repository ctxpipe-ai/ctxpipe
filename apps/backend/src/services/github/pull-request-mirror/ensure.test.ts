import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  bind: vi.fn(),
  patch: vi.fn(),
  listReposForOrg: vi.fn(),
  loadConfig: vi.fn(),
  commitYaml: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../../models/github-pr-mirror-target.js", () => ({
  resolveGithubPrMirrorTarget: mocks.resolveTarget,
}))
vi.mock("../../../models/github-pr-mirror.js", () => ({
  bindGithubPrMirror: mocks.bind,
  patchGithubPrMirror: mocks.patch,
}))
vi.mock("../../../models/repositories.js", () => ({
  listRepositoriesForGithubConnectionForOrg: mocks.listReposForOrg,
}))
vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/github-sync-content.js", () => ({
  githubSyncContent: { spec: "github-sync-content" },
  githubPrMirrorContentIdempotencyKey: ({
    connectionId,
    commitSha,
  }: {
    connectionId: string
    commitSha: string
  }) => `github-pr-mirror-content:${connectionId}:${commitSha}`,
}))
vi.mock("./config-from-repo.js", () => ({
  loadGithubPrMirrorConfigFromRepo: mocks.loadConfig,
}))
vi.mock("./sync.js", () => ({
  commitGithubPrMirrorConfigYaml: mocks.commitYaml,
}))

import { ensureGithubPrMirror } from "./ensure.js"

const binding = {
  enabled: true,
  setupPhase: "draft",
  repositoryId: "repo_ctx",
  repositoryName: "acme/ctxpipe-context",
  githubConnectionId: "con_gh",
  branch: "main",
}

describe("ensureGithubPrMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveTarget.mockResolvedValue({
      repositoryId: "repo_ctx",
      repositoryName: "acme/ctxpipe-context",
      branch: "main",
    })
    mocks.bind.mockResolvedValue(binding)
    mocks.listReposForOrg.mockResolvedValue([
      { name: "acme/api" },
      { name: "acme/ctxpipe-context" },
    ])
    mocks.loadConfig.mockResolvedValue(undefined)
    mocks.commitYaml.mockResolvedValue({ commitSha: "sha_config" })
  })

  it("skips when no context repository exists", async () => {
    mocks.resolveTarget.mockResolvedValue(null)
    await expect(
      ensureGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "skipped_no_context" })
    expect(mocks.commitYaml).not.toHaveBeenCalled()
  })

  it("writes yaml from the picker and starts backfill", async () => {
    mocks.commitYaml.mockImplementationOnce(async () => {
      expect(mocks.patch).not.toHaveBeenCalledWith(
        expect.objectContaining({
          patch: expect.objectContaining({ setupPhase: "initial_sync" }),
        }),
      )
      return { commitSha: "sha_config" }
    })

    await expect(
      ensureGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "started" })
    expect(mocks.commitYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: ["acme/api"],
      }),
    )
    expect(mocks.listReposForOrg).toHaveBeenCalledWith("org_1", "con_gh")
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      "github-sync-content",
      { orgId: "org_1", connectionId: "con_gh" },
      {
        idempotencyKey: "github-pr-mirror-content:con_gh:sha_config",
      },
    )
  })

  it("does not rewrite a live yaml that already matches the picker", async () => {
    mocks.bind.mockResolvedValue({ ...binding, setupPhase: "live" })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    await expect(
      ensureGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "unchanged" })
    expect(mocks.commitYaml).not.toHaveBeenCalled()
  })

  it("retries content when a matching mirror previously failed", async () => {
    mocks.bind.mockResolvedValue({ ...binding, setupPhase: "sync_failed" })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })

    await expect(
      ensureGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "started" })

    expect(mocks.commitYaml).toHaveBeenCalled()
    expect(mocks.runWorkflow).toHaveBeenCalled()
  })

  it("records a failed setup so the next ensure can retry", async () => {
    mocks.commitYaml.mockRejectedValueOnce(new Error("GitHub unavailable"))

    await expect(
      ensureGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).rejects.toThrow("GitHub unavailable")

    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })
})
