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

import {
  getGithubRepoWriteView,
  persistWorkspaceTipsOnDefaultBranchPush,
  resolveGithubBranchTip,
  resolveWorkspaceRepositoryTip,
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

describe("resolveGithubBranchTip", () => {
  it("returns the ref SHA from Octokit", async () => {
    const getRef = vi.fn(async () => ({ data: { object: { sha: "abc123" } } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: { rest: { git: { getRef } } },
    })
    const sha = await resolveGithubBranchTip({
      orgId: "org_1",
      githubConnectionId: "ghi_1",
      repoFullName: "acme/docs",
      branch: "develop",
      env: {} as never,
    })
    expect(sha).toBe("abc123")
    expect(getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      ref: "heads/develop",
    })
  })

  it("returns null when the App is missing", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue(undefined)
    await expect(
      resolveGithubBranchTip({
        orgId: "org_1",
        repoFullName: "acme/docs",
        branch: "main",
        env: {} as never,
      }),
    ).resolves.toBeNull()
  })
})

describe("resolveWorkspaceRepositoryTip", () => {
  it("resolves the repository default branch tip", async () => {
    const get = vi.fn(async () => ({ data: { default_branch: "develop" } }))
    const getRef = vi.fn(async () => ({ data: { object: { sha: "tipsha" } } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: { rest: { repos: { get }, git: { getRef } } },
    })
    await expect(
      resolveWorkspaceRepositoryTip({
        orgId: "org_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
        env: {} as never,
      }),
    ).resolves.toBe("tipsha")
    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "docs" })
    expect(getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      ref: "heads/develop",
    })
  })

  it("resolves a caller-supplied branch instead of the default branch", async () => {
    const get = vi.fn(async () => ({ data: { default_branch: "develop" } }))
    const getRef = vi.fn(async () => ({ data: { object: { sha: "relsha" } } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: { rest: { repos: { get }, git: { getRef } } },
    })
    await expect(
      resolveWorkspaceRepositoryTip({
        orgId: "org_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
        branch: "release",
        env: {} as never,
      }),
    ).resolves.toBe("relsha")
    expect(getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      ref: "heads/release",
    })
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
