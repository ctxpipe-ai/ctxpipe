import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  finalizeTarget: vi.fn(),
  getConnection: vi.fn(),
  getTarget: vi.fn(),
  loadConfig: vi.fn(),
  runIngestion: vi.fn(),
  fetchPage: vi.fn(),
  commitMirror: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}))
vi.mock("../../models/linear-connector.js", () => ({
  finalizeLinearBindingAfterContentWorkflow: mocks.finalizeTarget,
  getLinearConnectionByConnectionId: mocks.getConnection,
  getLinearBindingWithRepoByConnectionId: mocks.getTarget,
  refreshLinearConnectionTokensWithLock: vi.fn(),
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: vi.fn(() => ({ error: vi.fn() })),
}))
vi.mock("../../services/linear/config-from-repo.js", () => ({
  loadLinearScopeFromRepo: mocks.loadConfig,
}))
vi.mock("../../services/linear/content.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/linear/content.js")>()
  return { ...actual, fetchLinearMirrorPage: mocks.fetchPage }
})
vi.mock("../../services/linear/sync.js", () => ({
  commitLinearMirror: mocks.commitMirror,
}))
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runConnectorRepositoryIngestionWorkflow: mocks.runIngestion,
}))

import { linearSyncContent } from "./linear-sync-content.js"

function emptyPage(nextAfter: string | null = null) {
  return {
    files: [] as Array<{ path: string; content: string }>,
    nextAfter,
    failures: [] as Array<{ type: string; id: string; message: string }>,
    projects: [] as Array<{ id: string; teamIds: string[] }>,
    documentIds: [] as string[],
    childIds: [] as string[],
  }
}

describe("linearSyncContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finalizeTarget.mockResolvedValue(true)
    mocks.commitMirror.mockResolvedValue({
      status: "completed",
      written: 1,
      deleted: 0,
      commitSha: "sha-linear",
      failures: [],
    })
    mocks.fetchPage.mockImplementation(
      async (input: { request: { kind: string; after?: string | null } }) => {
        if (
          input.request.kind === "team-issues" &&
          input.request.after == null
        ) {
          return {
            ...emptyPage("issue-cursor"),
            files: [
              { path: "linear/issues/pro-1--issue-1.md", content: "one" },
            ],
          }
        }
        return emptyPage()
      },
    )
  })

  it("marks setup failed when loading sync context fails", async () => {
    mocks.getTarget.mockRejectedValueOnce(new Error("GitHub unavailable"))
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await expect(
      linearSyncContent.fn({
        input: { orgId: "org_1", connectionId: "con_linear" },
        step,
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      workflowStatus: "failed",
    })
  })

  it("marks the target live after initial sync without draining events", async () => {
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
      workspaceId: "workspace_1",
    })
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace_1",
      scopes: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(mocks.finalizeTarget).toHaveBeenCalledWith({
      connectionId: "con_linear",
      workflowStatus: "completed",
    })
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Linear content",
      },
      expect.any(Object),
    )
  })

  it("checks the branch tip when replaying an unchanged initial sync", async () => {
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
      workspaceId: "workspace_1",
    })
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace_1",
      scopes: [],
    })
    mocks.commitMirror.mockResolvedValue({
      status: "completed",
      written: 0,
      deleted: 0,
      failures: [],
    })
    const step = {
      run: async (_opts: { name: string }, operation: () => Promise<unknown>) =>
        operation(),
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: "repo_1",
        orgId: "org_1",
        targetBranch: "main",
        indexingReason: "Syncing Linear content",
      },
      expect.any(Object),
    )
  })

  it("keeps the checkpointed repository target when a binding is rebound during replay", async () => {
    const checkpointedTarget = {
      repositoryId: "repo_original",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "linear-capture",
      enabled: true,
      setupPhase: "initial_sync",
    }
    mocks.getTarget.mockResolvedValueOnce({
      ...checkpointedTarget,
      repositoryId: "repo_rebound",
      branch: "main",
    })
    const replayStep = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-linear-sync-context") {
          return {
            connection: {
              id: "con_linear",
              status: "installed",
              workspaceId: "workspace_1",
            },
            target: checkpointedTarget,
            config: { workspaceId: "workspace_1", scopes: [] },
          }
        }
        return operation()
      },
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step: replayStep,
    } as never)

    expect(mocks.commitMirror).toHaveBeenCalledWith(
      expect.objectContaining({ target: checkpointedTarget }),
    )
    expect(mocks.runIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repositoryId: "repo_original",
        targetBranch: "linear-capture",
      }),
      expect.any(Object),
    )
  })

  it("names one step per issue page and commits once", async () => {
    mocks.getTarget.mockResolvedValue({
      repositoryId: "repo_1",
      repositoryName: "acme/context",
      githubConnectionId: "con_github",
      branch: "main",
      enabled: true,
      setupPhase: "initial_sync",
    })
    mocks.getConnection.mockResolvedValue({
      id: "con_linear",
      status: "installed",
      workspaceId: "workspace_1",
    })
    mocks.loadConfig.mockResolvedValue({
      workspaceId: "workspace_1",
      scopes: [
        {
          externalId: "team-1",
          type: "team",
          title: "Product",
          url: null,
          parentExternalId: null,
          teamId: "team-1",
          teamKey: "PRO",
        },
      ],
    })
    const names: string[] = []
    const step = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        names.push(options.name)
        return operation()
      },
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(names).toEqual(
      expect.arrayContaining([
        "team-team-1-record",
        "team-team-1-issues-0",
        "team-team-1-issues-1",
        "team-team-1-projects-0",
        "team-team-1-cycles-0",
        "team-team-1-labels-0",
        "commit-linear-mirror",
      ]),
    )
    expect(mocks.commitMirror).toHaveBeenCalledTimes(1)
    expect(mocks.runIngestion).toHaveBeenCalledTimes(1)
  })

  it("skips a stored issue page and refetches only the unfinished page", async () => {
    const executed: string[] = []
    const step = {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        if (options.name === "load-linear-sync-context") {
          return {
            connection: {
              id: "con_linear",
              status: "installed",
              workspaceId: "workspace_1",
            },
            target: {
              repositoryId: "repo_1",
              repositoryName: "acme/context",
              githubConnectionId: "con_github",
              branch: "main",
              enabled: true,
              setupPhase: "initial_sync",
            },
            config: {
              workspaceId: "workspace_1",
              scopes: [
                {
                  externalId: "team-1",
                  type: "team",
                  title: "Product",
                  url: null,
                  parentExternalId: null,
                  teamId: "team-1",
                  teamKey: "PRO",
                },
              ],
            },
          }
        }
        if (options.name === "team-team-1-issues-0") {
          return {
            ...emptyPage("issue-cursor"),
            files: [
              { path: "linear/issues/pro-1--issue-1.md", content: "stored" },
            ],
          }
        }
        executed.push(options.name)
        return operation()
      },
    }

    await linearSyncContent.fn({
      input: { orgId: "org_1", connectionId: "con_linear" },
      step,
    } as never)

    expect(executed).not.toContain("team-team-1-issues-0")
    expect(executed).toContain("team-team-1-issues-1")
    expect(mocks.fetchPage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          kind: "team-issues",
          after: null,
        }),
      }),
    )
    expect(mocks.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          kind: "team-issues",
          after: "issue-cursor",
        }),
      }),
    )
    expect(mocks.commitMirror).toHaveBeenCalledTimes(1)
  })
})
