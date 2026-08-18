import { beforeEach, describe, expect, it, vi } from "vitest"

const persistHydrateFailureMock = vi.hoisted(() => vi.fn())
const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())
const findRepositoriesByNormalizedGitUrlsMock = vi.hoisted(() => vi.fn())
const getGithubConnectionIdForRepositoryMock = vi.hoisted(() => vi.fn())
const ensureWorkspaceCheckoutMock = vi.hoisted(() => vi.fn())
const persistIndexedShaMock = vi.hoisted(() => vi.fn())
const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: () => unknown) => {
    orgTxDepth.value += 1
    try {
      return await fn()
    } finally {
      orgTxDepth.value -= 1
    }
  }),
)

vi.mock("../../db/client.js", () => ({
  getSystemDb: () => ({
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: "org_1", slug: "acme" }),
      },
    },
  }),
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
  listLinkedRepositories: vi.fn(),
  persistIndexedSha: persistIndexedShaMock,
  persistLinkedIndexedSha: vi.fn(),
  persistHydrateFailure: persistHydrateFailureMock,
}))

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls:
    findRepositoriesByNormalizedGitUrlsMock,
  getGithubConnectionIdForRepository: getGithubConnectionIdForRepositoryMock,
  ensureWorkspaceCheckout: ensureWorkspaceCheckoutMock,
}))

vi.mock("./repository-index.js", () => ({
  repositoryIndex: { spec: { name: "repository-index" } },
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: {
      input: {
        orgId: string
        workspaceId: string
        gitUrl: string
        desiredSha: string
        role: "workspace" | "linked"
        jobGeneration: number
        jobWorkspaceUrl: string
      }
      step: {
        runWorkflow: (
          spec: unknown,
          input: unknown,
          opts?: unknown,
        ) => Promise<unknown>
      }
    }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "workspace-index" },
  }),
}))

import { workspaceIndex } from "./workspace-index.js"

const indexFn = workspaceIndex as unknown as {
  fn: (args: {
    input: {
      orgId: string
      workspaceId: string
      gitUrl: string
      desiredSha: string
      role: "workspace" | "linked"
      jobGeneration: number
      jobWorkspaceUrl: string
    }
    step: {
      runWorkflow: (
        spec: unknown,
        input: unknown,
        opts?: unknown,
      ) => Promise<unknown>
    }
  }) => Promise<unknown>
}

const workspaceInput = {
  orgId: "org_1",
  workspaceId: "ws_1",
  gitUrl: "https://github.com/ctxpipe-ai/context",
  desiredSha: "abc123def456",
  role: "workspace" as const,
  jobGeneration: 1,
  jobWorkspaceUrl: "https://github.com/ctxpipe-ai/context",
}

describe("workspaceIndex workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orgTxDepth.value = 0
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      activeProjectionSha: null,
      desiredGeneration: 1,
      workspaceRepositoryUrl: "https://github.com/ctxpipe-ai/context",
    })
    findRepositoriesByNormalizedGitUrlsMock.mockResolvedValue([
      { id: "repo_1", gitUrl: "https://github.com/ctxpipe-ai/context" },
    ])
    getGithubConnectionIdForRepositoryMock.mockResolvedValue("con_1")
    ensureWorkspaceCheckoutMock.mockResolvedValue(undefined)
    persistHydrateFailureMock.mockResolvedValue(undefined)
    persistIndexedShaMock.mockResolvedValue(true)
  })

  it("persists a friendly hydrate error when clone-checkout 404s before the first projection", async () => {
    const step = {
      runWorkflow: vi.fn().mockRejectedValue(
        new Error(
          "codesearch index clone-checkout failed with status 404: Repository not found or access denied",
        ),
      ),
    }

    await expect(
      indexFn.fn({ input: workspaceInput, step }),
    ).rejects.toThrow(/clone-checkout failed with status 404/)

    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "We could not open this repository for indexing.",
    })
  })

  it("persists a friendly hydrate error when the workspace repo is not registered for indexing", async () => {
    findRepositoriesByNormalizedGitUrlsMock.mockResolvedValue([])
    const step = { runWorkflow: vi.fn() }

    await expect(
      indexFn.fn({ input: workspaceInput, step }),
    ).resolves.toEqual({ published: false, reason: "no_repository" })

    expect(step.runWorkflow).not.toHaveBeenCalled()
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "We could not open this repository for indexing.",
    })
  })

  it("indexes with the workspace GitHub connection when the repository row has none", async () => {
    getGithubConnectionIdForRepositoryMock.mockResolvedValue(null)
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      activeProjectionSha: null,
      githubConnectionId: "con_ws",
      desiredGeneration: 1,
      workspaceRepositoryUrl: "https://github.com/ctxpipe-ai/context",
    })
    const step = { runWorkflow: vi.fn().mockResolvedValue(undefined) }

    await indexFn.fn({ input: workspaceInput, step })

    expect(step.runWorkflow).toHaveBeenCalledWith(
      { name: "repository-index" },
      expect.objectContaining({
        githubConnectionId: "con_ws",
        workspaceId: "ws_1",
      }),
      { name: "repository-index" },
    )
  })

  it("does not call codesearch while the org transaction is still open", async () => {
    const step = {
      runWorkflow: vi.fn().mockImplementation(() => {
        expect(orgTxDepth.value).toBe(0)
        return Promise.resolve()
      }),
    }

    await indexFn.fn({ input: workspaceInput, step })

    expect(ensureWorkspaceCheckoutMock).toHaveBeenCalled()
    expect(step.runWorkflow).toHaveBeenCalled()
  })
})
