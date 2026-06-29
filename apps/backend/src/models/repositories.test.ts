import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgSlugMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() => vi.fn())
const withGraphClientMock = vi.hoisted(() => vi.fn())
const deleteRepositoryWithCleanupMock = vi.hoisted(() => vi.fn())

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: vi.fn(),
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

import { pruneGithubConnectionRepositoriesNotInGitUrls } from "./repositories.js"

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
