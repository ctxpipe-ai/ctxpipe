import { beforeEach, describe, expect, it, vi } from "vitest"

const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const persistResolvedDesiredShaMock = vi.hoisted(() => vi.fn())
const getInstallationOctokitForOrgMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: () => unknown) => fn()),
)
const assertNotInOrgDbContextMock = vi.hoisted(() => vi.fn())

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: withOrgDbContextMock,
  assertNotInOrgDbContext: assertNotInOrgDbContextMock,
}))

vi.mock("../../../models/workspaces.js", () => ({
  listOrgWorkspaces: listOrgWorkspacesMock,
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
  listOrgLinkedRepositories: vi.fn().mockResolvedValue([]),
  persistLinkedDesiredSha: vi.fn(),
}))

vi.mock("../../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

const enqueueWorkspaceCommitProjectionMock = vi.hoisted(() => vi.fn())

vi.mock("../../../openworkflow/enqueue-workspace-commit-projection.js", () => ({
  enqueueWorkspaceCommitProjection: enqueueWorkspaceCommitProjectionMock,
}))

import {
  getGithubRepoWriteView,
  persistWorkspaceTipsOnDefaultBranchPush,
} from "./github-workspace-tip.js"

describe("persistWorkspaceTipsOnDefaultBranchPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withOrgDbContextMock.mockImplementation(async (_orgId, fn) => fn())
    assertNotInOrgDbContextMock.mockReset()
  })

  it("persists the resolved tip and ignores payload after", async () => {
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: "ws_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
        desiredGeneration: 2,
        desiredSha: "old",
      },
    ])
    persistResolvedDesiredShaMock.mockResolvedValue(true)
    const resolveTip = vi.fn(async () => "resolved-from-github")

    const persisted = await persistWorkspaceTipsOnDefaultBranchPush({
      orgId: "org_1",
      repoFullName: "acme/docs",
      defaultBranch: "main",
      payloadAfter: "do-not-persist-me",
      resolveTip,
    })

    expect(persisted).toBe(1)
    expect(resolveTip).toHaveBeenCalledWith("acme/docs", "main")
    expect(persistResolvedDesiredShaMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      resolvedTip: "resolved-from-github",
      expectedGeneration: 2,
      expectedUrl: "https://github.com/acme/docs.git",
      expectedDesiredSha: "old",
    })
    expect(
      persistResolvedDesiredShaMock.mock.calls[0]?.[0].resolvedTip,
    ).not.toBe("do-not-persist-me")
    expect(enqueueWorkspaceCommitProjectionMock).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      expect.anything(),
    )
  })

  it("lists in an org tx, resolves GitHub over HTTP, then persists in a new org tx", async () => {
    const order: string[] = []
    withOrgDbContextMock.mockImplementation(async (_orgId, fn) => {
      order.push("tx")
      return fn()
    })
    listOrgWorkspacesMock.mockImplementation(async () => {
      order.push("list")
      return [
        {
          id: "ws_1",
          workspaceRepositoryUrl: "https://github.com/acme/docs.git",
          desiredGeneration: 1,
          desiredSha: null,
        },
      ]
    })
    persistResolvedDesiredShaMock.mockImplementation(async () => {
      order.push("persist")
      return true
    })
    const resolveTip = vi.fn(async () => {
      order.push("http")
      return "tip"
    })

    await persistWorkspaceTipsOnDefaultBranchPush({
      orgId: "org_1",
      repoFullName: "acme/docs",
      defaultBranch: "main",
      resolveTip,
    })

    expect(order).toEqual(["tx", "list", "http", "tx", "persist"])
    expect(assertNotInOrgDbContextMock).toHaveBeenCalled()
  })
})

describe("getGithubRepoWriteView", () => {
  const env = {} as never

  it("treats App contents:write or push as writable", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: {
        rest: {
          repos: {
            get: async () => ({
              data: {
                default_branch: "main",
                permissions: { contents: "write" },
              },
            }),
          },
        },
      },
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).resolves.toEqual({ defaultBranch: "main", canPush: true })

    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: {
        rest: {
          repos: {
            get: async () => ({
              data: {
                default_branch: "main",
                permissions: { push: true },
              },
            }),
          },
        },
      },
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).resolves.toEqual({ defaultBranch: "main", canPush: true })
  })

  it("treats a successful repos.get without permissions as writable", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: {
        rest: {
          repos: {
            get: async () => ({
              data: { default_branch: "develop" },
            }),
          },
        },
      },
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).resolves.toEqual({ defaultBranch: "develop", canPush: true })
  })

  it("treats installation contents:write as writable when repos.get only reports pull", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue({
      installation: { installationId: 42 },
      octokit: {
        rest: {
          repos: {
            get: async () => ({
              data: {
                default_branch: "main",
                permissions: { pull: true },
              },
            }),
          },
          apps: {
            getInstallation: async () => ({
              data: { permissions: { contents: "write" } },
            }),
          },
        },
      },
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).resolves.toEqual({ defaultBranch: "main", canPush: true })
  })

  it("denies pull-only permissions", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: {
        rest: {
          repos: {
            get: async () => ({
              data: {
                default_branch: "main",
                permissions: { pull: true },
              },
            }),
          },
          apps: {
            getInstallation: async () => ({
              data: { permissions: { contents: "read" } },
            }),
          },
        },
      },
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).resolves.toEqual({ defaultBranch: "main", canPush: false })
  })

  it("does not mark an installation lookup miss as a 404 deny", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue(undefined)
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }),
    ).rejects.toMatchObject({
      message: "GitHub installation not found",
    })
    await expect(
      getGithubRepoWriteView({
        orgId: "org_1",
        githubConnectionId: "con_gh",
        repoFullName: "acme/docs",
        env,
      }).catch((error: { status?: number }) => error.status),
    ).resolves.toBeUndefined()
  })
})
