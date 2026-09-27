import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getOrgDb: vi.fn(),
  getRepositoryForOrg: vi.fn(),
  getSystemDb: vi.fn(),
  update: vi.fn(),
  mergeConfig: vi.fn(
    (_config: Record<string, unknown>, patch: Record<string, unknown>) => patch,
  ),
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: mocks.getOrgDb,
  getSystemDb: mocks.getSystemDb,
  withOrgDbContext: (_orgId: string, fn: (db: unknown) => unknown) =>
    fn(mocks.getOrgDb()),
}))

vi.mock("./connection-rows.js", () => ({
  mergeGithubConnectionConfig: mocks.mergeConfig,
}))

vi.mock("./github-installation.js", () => ({
  getGithubConnectionRow: mocks.getConnection,
}))

vi.mock("./repositories.js", () => ({
  DEFAULT_CHECKOUT_KEY: "default",
  getRepositoryForOrg: mocks.getRepositoryForOrg,
}))

import { bindGithubPrMirror, patchGithubPrMirror } from "./github-pr-mirror.js"

describe("bindGithubPrMirror", () => {
  let connectionRow: {
    id: string
    orgId: string
    contentSyncGeneration: number
    config: Record<string, unknown>
  }
  let setPayload: Record<string, unknown> | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    setPayload = undefined
    connectionRow = {
      id: "con_gh",
      orgId: "org_1",
      contentSyncGeneration: 0,
      config: {
        ingestAllRepositories: false,
        includeFutureRepos: false,
      },
    }
    mocks.getConnection.mockResolvedValue(connectionRow)
    const repository = {
      id: "repo_ctx",
      orgId: "org_1",
      name: "acme/ctxpipe-context",
      gitUrl: "https://github.com/acme/ctxpipe-context.git",
      githubConnectionId: "con_gh",
    }
    const rows = {
      connection: [connectionRow],
      repository: [repository],
    }
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              for: vi.fn().mockResolvedValue(rows.connection),
            }),
          }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows.repository),
          }),
        }),
      }))
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn((payload: Record<string, unknown>) => {
      setPayload = payload
      return { where: updateWhere }
    })
    mocks.update.mockReturnValue({ set })
    mocks.getOrgDb.mockReturnValue({
      select,
      update: mocks.update,
      execute: vi.fn().mockResolvedValue(undefined),
    })
    mocks.getRepositoryForOrg.mockResolvedValue(null)
    mocks.getSystemDb.mockImplementation(() => {
      throw new Error("system DB cannot see the uncommitted repository")
    })
  })

  it("binds a context repository created in the active org transaction", async () => {
    await expect(
      bindGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toMatchObject({
      connectionId: "con_gh",
      orgId: "org_1",
      repositoryId: "repo_ctx",
      repositoryName: "acme/ctxpipe-context",
      enabled: true,
      setupPhase: "draft",
    })
    expect(mocks.update).toHaveBeenCalled()
  })

  it("preserves the phase when the mirror is already bound to the same target", async () => {
    connectionRow.config = {
      ingestAllRepositories: false,
      includeFutureRepos: false,
      prMirror: {
        repositoryId: "repo_ctx",
        branch: "main",
        enabled: true,
        setupPhase: "sync_failed",
        pendingConfigPullUrl: null,
      },
    }

    await expect(
      bindGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toMatchObject({
      setupPhase: "sync_failed",
      contentSyncGeneration: 0,
    })
    expect(setPayload).not.toMatchObject({ contentSyncGeneration: 1 })
  })

  it("bumps contentSyncGeneration when rebound to a different repository", async () => {
    connectionRow.contentSyncGeneration = 3
    connectionRow.config = {
      ingestAllRepositories: false,
      includeFutureRepos: false,
      prMirror: {
        repositoryId: "repo_r1",
        branch: "main",
        enabled: true,
        setupPhase: "initial_sync",
        pendingConfigPullUrl: null,
      },
    }

    await expect(
      bindGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toMatchObject({
      repositoryId: "repo_ctx",
      setupPhase: "draft",
      contentSyncGeneration: 4,
    })
    expect(setPayload).toMatchObject({ contentSyncGeneration: 4 })
  })
})

describe("patchGithubPrMirror", () => {
  let connectionRow: {
    id: string
    orgId: string
    contentSyncGeneration: number
    contentSyncWorkflowRunId: string | null
    config: Record<string, unknown>
  }
  let setPayload: Record<string, unknown> | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    setPayload = undefined
    connectionRow = {
      id: "con_gh",
      orgId: "org_1",
      contentSyncGeneration: 2,
      contentSyncWorkflowRunId: "run_b",
      config: {
        ingestAllRepositories: false,
        includeFutureRepos: false,
        prMirror: {
          repositoryId: "repo_ctx",
          branch: "main",
          enabled: true,
          setupPhase: "live",
          lastContentCommitSha: "sha_b",
          lastContentLaunchToken: "tok_b",
        },
      },
    }
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([connectionRow]),
          }),
        }),
      }),
    })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn((payload: Record<string, unknown>) => {
      setPayload = payload
      return { where: updateWhere }
    })
    mocks.update.mockReturnValue({ set })
    mocks.getOrgDb.mockReturnValue({
      select,
      update: mocks.update,
      execute: vi.fn().mockResolvedValue(undefined),
    })
    mocks.mergeConfig.mockImplementation(
      (config: Record<string, unknown>, patch: Record<string, unknown>) => ({
        ingestAllRepositories: false,
        includeFutureRepos: false,
        ...config,
        ...patch,
      }),
    )
  })

  it("supersedes a retained legacy claim after a reserved identity is live", async () => {
    await expect(
      patchGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        workflowRunId: "run_legacy_a",
        claimContentRun: true,
        patch: { setupPhase: "initial_sync" },
      }),
    ).resolves.toEqual({
      applied: false,
      contentSyncGeneration: 2,
      repositoryId: "repo_ctx",
      branch: "main",
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("lets a pre-marker legacy claim activate untouched generation-0 state", async () => {
    connectionRow.contentSyncGeneration = 0
    connectionRow.contentSyncWorkflowRunId = null
    connectionRow.config = {
      ingestAllRepositories: false,
      includeFutureRepos: false,
      prMirror: {
        repositoryId: "repo_ctx",
        branch: "main",
        enabled: true,
        setupPhase: "draft",
        lastContentCommitSha: null,
        lastContentLaunchToken: null,
      },
    }

    await expect(
      patchGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        workflowRunId: "run_legacy_a",
        claimContentRun: true,
        patch: { setupPhase: "initial_sync" },
      }),
    ).resolves.toEqual({
      applied: true,
      contentSyncGeneration: 1,
      repositoryId: "repo_ctx",
      branch: "main",
    })
    expect(setPayload).toMatchObject({
      contentSyncGeneration: 1,
      contentSyncWorkflowRunId: "run_legacy_a",
    })
  })
})
