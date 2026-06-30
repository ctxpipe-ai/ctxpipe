import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn())
const requireCurrentOrgSlugMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() => vi.fn())
const withGraphClientMock = vi.hoisted(() => vi.fn())
const deleteRepositoryWithCleanupMock = vi.hoisted(() => vi.fn())

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentOrgSlug: requireCurrentOrgSlugMock,
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
}))

vi.mock("../platform/graph/client.js", () => ({
  withGraphClient: withGraphClientMock,
}))

vi.mock("../domain/repositoryDeletion.js", () => ({
  deleteRepositoryWithCleanup: deleteRepositoryWithCleanupMock,
}))

import {
  listRepositoriesForGithubConnection,
  pruneGithubConnectionRepositoriesNotInGitUrls,
} from "./repositories.js"

const orgId = "org_1"
const githubConnectionId = "con_github"
const orgSlug = "acme"

function mockLinkedRepos(
  rows: Array<{ id: string; gitUrl: string }>,
) {
  getOrgDbMock.mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  })
}

function mockRepositoriesWithZoekt(rows: Array<Record<string, unknown>>) {
  const where = vi.fn().mockResolvedValue(rows)
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  getOrgDbMock.mockReturnValue({ select })
  return { select, from, innerJoin, where }
}

describe("listRepositoriesForGithubConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgIdMock.mockReturnValue(orgId)
  })

  it("returns repositories for the current org and GitHub connection", async () => {
    const rows = [
      {
        id: "repo_linked",
        orgId,
        name: "acme/linked",
        gitUrl: "https://github.com/acme/linked.git",
        indexReady: false,
        indexingReason: null,
        lastIngestedHash: null,
        githubConnectionId,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        zoektRepoId: 1,
      },
    ]
    const query = mockRepositoriesWithZoekt(rows)

    await expect(
      listRepositoriesForGithubConnection(githubConnectionId),
    ).resolves.toEqual(rows)
    expect(query.where).toHaveBeenCalledTimes(1)
  })
})

describe("pruneGithubConnectionRepositoriesNotInGitUrls", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireCurrentOrgSlugMock.mockReturnValue(orgSlug)
    withGraphClientMock.mockImplementation(
      (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
    )
    deleteRepositoryWithCleanupMock.mockResolvedValue(true)
  })

  it("deletes repos linked to the connection that are not in the allowed gitUrl set", async () => {
    mockLinkedRepos([
      { id: "repo_keep", gitUrl: "https://github.com/acme/keep.git" },
      { id: "repo_drop_a", gitUrl: "https://github.com/acme/drop-a.git" },
      { id: "repo_drop_b", gitUrl: "https://github.com/acme/drop-b.git" },
    ])

    await pruneGithubConnectionRepositoriesNotInGitUrls(
      orgId,
      githubConnectionId,
      new Set(["https://github.com/acme/keep.git"]),
    )

    expect(deleteRepositoryWithCleanupMock).toHaveBeenCalledTimes(2)
    expect(deleteRepositoryWithCleanupMock).toHaveBeenCalledWith({
      orgId,
      repositoryId: "repo_drop_a",
    })
    expect(deleteRepositoryWithCleanupMock).toHaveBeenCalledWith({
      orgId,
      repositoryId: "repo_drop_b",
    })
    expect(withGraphClientMock).toHaveBeenCalledTimes(2)
    expect(withGraphClientMock).toHaveBeenCalledWith(
      { orgId, orgSlug },
      expect.any(Function),
    )
  })

  it("does not delete repos when all linked gitUrls are allowed", async () => {
    mockLinkedRepos([
      { id: "repo_a", gitUrl: "https://github.com/acme/a.git" },
      { id: "repo_b", gitUrl: "https://github.com/acme/b.git" },
    ])

    await pruneGithubConnectionRepositoriesNotInGitUrls(
      orgId,
      githubConnectionId,
      new Set([
        "https://github.com/acme/a.git",
        "https://github.com/acme/b.git",
      ]),
    )

    expect(deleteRepositoryWithCleanupMock).not.toHaveBeenCalled()
    expect(withGraphClientMock).not.toHaveBeenCalled()
  })

  it("does nothing when the connection has no linked repositories", async () => {
    mockLinkedRepos([])

    await pruneGithubConnectionRepositoriesNotInGitUrls(
      orgId,
      githubConnectionId,
      new Set(["https://github.com/acme/any.git"]),
    )

    expect(deleteRepositoryWithCleanupMock).not.toHaveBeenCalled()
  })
})
