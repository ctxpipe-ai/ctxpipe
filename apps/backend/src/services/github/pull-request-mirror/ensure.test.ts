import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  bind: vi.fn(),
  patch: vi.fn(),
  listReposForOrg: vi.fn(),
  loadConfig: vi.fn(),
  prepareYaml: vi.fn(),
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
vi.mock("./config-from-repo.js", () => ({
  loadGithubPrMirrorConfigFromRepo: mocks.loadConfig,
}))
vi.mock("./sync.js", () => ({
  prepareGithubPrMirrorConfigYaml: mocks.prepareYaml,
}))

import {
  planGithubPrMirrorEnsure,
  recordGithubPrMirrorEnsureFailure,
} from "./ensure.js"

const revisionSha = "a".repeat(40)
const binding = {
  enabled: true,
  setupPhase: "draft",
  repositoryId: "repo_ctx",
  repositoryName: "acme/ctxpipe-context",
  githubConnectionId: "con_gh",
  connectionId: "con_gh",
  gitUrl: "https://github.com/acme/ctxpipe-context.git",
  branch: "main",
  contentSyncGeneration: 0,
}

const prepared = {
  jobId: "wjob_ghprcfg_con_gh_sha",
  files: [{ path: "github/config.yaml", content: "version: 1\n" }],
  captured: {
    workspaceId: "ws_1",
    revision: {
      workspaceId: "ws_1",
      generation: 1,
      remote: {
        url: "https://github.com/acme/ctxpipe-context.git",
        connectionId: "con_gh",
      },
      defaultBranch: "main",
      sha: revisionSha,
      access: "write-default" as const,
    },
    mirror: {
      provider: "github" as const,
      connectionId: "con_gh",
      repositoryId: "repo_ctx",
      configBlobSha: null,
    },
  },
}

describe("planGithubPrMirrorEnsure", () => {
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
    mocks.prepareYaml.mockResolvedValue(prepared)
  })

  it("skips when no context repository exists", async () => {
    mocks.resolveTarget.mockResolvedValue(null)
    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "skipped_no_context" })
    expect(mocks.prepareYaml).not.toHaveBeenCalled()
  })

  it("plans a config write from the picker without publishing", async () => {
    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({
      status: "write_config",
      orgId: "org_1",
      connectionId: "con_gh",
      contentSyncGeneration: 0,
      fallbackCommitSha: revisionSha,
      mirrorInput: {
        orgId: "org_1",
        workspaceId: "ws_1",
        revision: prepared.captured.revision,
        mirror: prepared.captured.mirror,
        jobId: prepared.jobId,
        files: prepared.files,
        deletePaths: [],
      },
    })
    expect(mocks.prepareYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: ["acme/api"],
      }),
    )
    expect(mocks.listReposForOrg).toHaveBeenCalledWith("org_1", "con_gh")
    expect(mocks.patch).not.toHaveBeenCalled()
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
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({ status: "unchanged" })
    expect(mocks.prepareYaml).not.toHaveBeenCalled()
  })

  it("retries content when a matching mirror previously failed", async () => {
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: revisionSha,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })

    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({
      status: "retry_content",
      commitSha: revisionSha,
      launchToken: null,
    })

    expect(mocks.prepareYaml).not.toHaveBeenCalled()
  })

  it("retries a failed manual launch token instead of the SHA-only identity", async () => {
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: revisionSha,
      lastContentLaunchToken: "tok_manual",
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })

    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toEqual({
      status: "retry_content",
      commitSha: revisionSha,
      launchToken: "tok_manual",
    })

    expect(mocks.prepareYaml).not.toHaveBeenCalled()
  })

  it("rewrites config when a failed mirror has no recorded content commit", async () => {
    mocks.bind.mockResolvedValue({ ...binding, setupPhase: "sync_failed" })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })

    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toMatchObject({ status: "write_config" })

    expect(mocks.prepareYaml).toHaveBeenCalled()
  })

  it("rewrites config when a failed ensure left no content handoff marker", async () => {
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: null,
      lastContentLaunchToken: null,
      contentSyncGeneration: 2,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })

    await expect(
      planGithubPrMirrorEnsure({
        orgId: "org_1",
        connectionId: "con_gh",
        env: {} as never,
      }),
    ).resolves.toMatchObject({
      status: "write_config",
      contentSyncGeneration: 2,
    })

    expect(mocks.prepareYaml).toHaveBeenCalled()
  })
})

describe("recordGithubPrMirrorEnsureFailure", () => {
  it("records a failed setup only for the ensure generation that still owns the stage", async () => {
    await recordGithubPrMirrorEnsureFailure({
      orgId: "org_1",
      connectionId: "con_gh",
      expectedContentSyncGeneration: 2,
    })
    expect(mocks.patch).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_gh",
      expectedContentSyncGeneration: 2,
      patch: { setupPhase: "sync_failed" },
    })
  })
})
