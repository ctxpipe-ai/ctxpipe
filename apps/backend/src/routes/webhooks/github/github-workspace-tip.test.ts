import { describe, expect, it, vi } from "vitest"

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

import { getGithubRepoWriteView } from "./github-workspace-tip.js"

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
