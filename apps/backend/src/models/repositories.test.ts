import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() => vi.fn())
const getSystemDbMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => fn()),
)
const purgeRepositoryPostgresMock = vi.hoisted(() => vi.fn())
const notifyCodesearchRepositoryDeletedMock = vi.hoisted(() => vi.fn())
const enqueueDeletionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ jobId: "run_1", status: "queued" }),
)

vi.mock("../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
}))

vi.mock("../db/client.js", () => ({
  tryGetOrgDb: () => ({}),
  tryGetOrgDbOrgId: () => "org_test",
  assertNotInOrgDbContext: () => undefined,

  getOrgDb: getOrgDbMock,
  getSystemDb: getSystemDbMock,
  withOrgDbContext: withOrgDbContextMock,
}))

vi.mock("../domain/repositoryDeletion.js", () => ({
  purgeRepositoryPostgres: purgeRepositoryPostgresMock,
  notifyCodesearchRepositoryDeleted: notifyCodesearchRepositoryDeletedMock,
}))

vi.mock("../openworkflow/enqueue-repository-deletion.js", () => ({
  enqueueRepositoryDeletionWorkflow: enqueueDeletionMock,
}))

import {
  deleteRepository,
  pruneGithubConnectionRepositoriesNotInGitUrls,
  setRepositoryIndexingStep,
} from "./repositories.js"

const orgId = "org_1"
const githubConnectionId = "con_github"
const repositoryId = "repo_AAAAAAAAAAAAAAAAAAAAAAAAAA"

describe("pruneGithubConnectionRepositoriesNotInGitUrls", () => {
  function mockPruneDb(
    rows: Array<{
      id: string
      gitUrl: string
      name?: string
      zoektRepoId?: number
    }>,
  ) {
    const where = vi.fn().mockResolvedValue(
      rows.map((r) => ({
        name: r.name ?? r.id,
        zoektRepoId: r.zoektRepoId ?? 1,
        ...r,
      })),
    )
    const innerJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ innerJoin })
    const select = vi.fn().mockReturnValue({ from })
    getOrgDbMock.mockReturnValue({ select })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    enqueueDeletionMock.mockResolvedValue({ jobId: "run_1", status: "queued" })
  })

  it("enqueues durable deletion for repos not in the allowed gitUrl set", async () => {
    mockPruneDb([
      { id: "repo_keep", gitUrl: "https://github.com/acme/keep.git" },
      { id: "repo_drop_a", gitUrl: "https://github.com/acme/drop-a.git" },
      { id: "repo_drop_b", gitUrl: "https://github.com/acme/drop-b.git" },
    ])

    await pruneGithubConnectionRepositoriesNotInGitUrls(
      orgId,
      githubConnectionId,
      new Set(["https://github.com/acme/keep.git"]),
    )

    expect(enqueueDeletionMock).toHaveBeenCalledTimes(2)
    expect(enqueueDeletionMock).toHaveBeenCalledWith(
      {
        orgId,
        repositoryId: "repo_drop_a",
        repoName: "repo_drop_a",
        zoektRepoId: 1,
      },
      expect.any(Object),
    )
    expect(enqueueDeletionMock).toHaveBeenCalledWith(
      {
        orgId,
        repositoryId: "repo_drop_b",
        repoName: "repo_drop_b",
        zoektRepoId: 1,
      },
      expect.any(Object),
    )
  })

  it("does not enqueue when all linked gitUrls are allowed", async () => {
    mockPruneDb([
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

    expect(enqueueDeletionMock).not.toHaveBeenCalled()
  })

  it("does nothing when the connection has no linked repositories", async () => {
    mockPruneDb([])

    await pruneGithubConnectionRepositoriesNotInGitUrls(
      orgId,
      githubConnectionId,
      new Set(["https://github.com/acme/any.git"]),
    )

    expect(enqueueDeletionMock).not.toHaveBeenCalled()
  })
})

describe("deleteRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withOrgDbContextMock.mockImplementation(
      (_orgId: string, fn: () => unknown) => fn(),
    )
    purgeRepositoryPostgresMock.mockResolvedValue({
      deleted: true,
      alreadyGone: false,
      name: "ctxpipe",
      zoektRepoId: 9,
      stats: {},
    })
    notifyCodesearchRepositoryDeletedMock.mockResolvedValue(undefined)
  })

  it("runs the Postgres purge inside withOrgDbContext, then tells codesearch", async () => {
    await deleteRepository({ orgId, repositoryId })

    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      orgId,
      expect.any(Function),
    )
    expect(purgeRepositoryPostgresMock).toHaveBeenCalledWith({
      orgId,
      repositoryId,
    })
    expect(notifyCodesearchRepositoryDeletedMock).toHaveBeenCalledWith({
      orgId,
      repositoryId,
      repoName: "ctxpipe",
      zoektRepoId: 9,
    })
    const codesearchCallOrder =
      notifyCodesearchRepositoryDeletedMock.mock.invocationCallOrder[0]
    if (codesearchCallOrder === undefined)
      throw new Error("Codesearch was not told")
    expect(withOrgDbContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      codesearchCallOrder,
    )
  })

  it("skips codesearch when the repository is already gone", async () => {
    purgeRepositoryPostgresMock.mockResolvedValue({
      deleted: false,
      alreadyGone: true,
      name: null,
      zoektRepoId: null,
      stats: {},
    })

    await expect(deleteRepository({ orgId, repositoryId })).resolves.toBe(false)

    expect(notifyCodesearchRepositoryDeletedMock).not.toHaveBeenCalled()
  })
})

describe("setRepositoryIndexingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockUpdateChain() {
    const where = vi.fn().mockResolvedValue([])
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })
    return { update, set, where }
  }

  it("sets step columns for a known key", async () => {
    const { set, where } = mockUpdateChain()

    await setRepositoryIndexingStep({
      repositoryId,
      key: "queued",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        indexingStepKey: "queued",
        indexingStep: expect.any(Number),
        indexingStepTotal: expect.any(Number),
      }),
    )
    expect(where).toHaveBeenCalledTimes(1)
  })

  it("no-ops for an unknown key", async () => {
    const { update } = mockUpdateChain()

    await setRepositoryIndexingStep({
      repositoryId,
      key: "scip:unknownlang",
    })

    expect(update).not.toHaveBeenCalled()
  })

  it("uses a simple eq WHERE without monotonic flag", async () => {
    const { where } = mockUpdateChain()

    await setRepositoryIndexingStep({ repositoryId, key: "resolving_ref" })

    expect(where).toHaveBeenCalledTimes(1)
  })

  it("adds a monotonic WHERE guard when monotonic: true", async () => {
    // Capture WHERE arg for non-monotonic...
    const { where: wherePlain } = mockUpdateChain()
    await setRepositoryIndexingStep({ repositoryId, key: "resolving_ref" })
    const plainArg = wherePlain.mock.calls[0]?.[0]

    // ...and for monotonic — they must differ (AND wraps extra conditions).
    const { where: whereMono } = mockUpdateChain()
    await setRepositoryIndexingStep({
      repositoryId,
      key: "resolving_ref",
      monotonic: true,
    })
    const monoArg = whereMono.mock.calls[0]?.[0]

    expect(whereMono).toHaveBeenCalledTimes(1)
    // monotonic arg is a different (larger) SQL expression than plain eq(id)
    expect(monoArg).not.toBe(plainArg)
    expect(monoArg).not.toStrictEqual(plainArg)
  })
})
