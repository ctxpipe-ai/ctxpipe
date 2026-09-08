import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() => vi.fn())
const getSystemDbMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn((_orgId: string, fn: () => unknown) => fn()),
)
const withGraphClientMock = vi.hoisted(() => vi.fn())
const purgeRepositoryPostgresMock = vi.hoisted(() => vi.fn())
const applyRepositoryDeletionGraphCleanupMock = vi.hoisted(() => vi.fn())
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

vi.mock("../platform/graph/client.js", () => ({
  withGraphClient: withGraphClientMock,
}))

vi.mock("../domain/repositoryDeletion.js", () => ({
  purgeRepositoryPostgres: purgeRepositoryPostgresMock,
  applyRepositoryDeletionGraphCleanup: applyRepositoryDeletionGraphCleanupMock,
  notifyCodesearchRepositoryDeleted: notifyCodesearchRepositoryDeletedMock,
}))

vi.mock("../openworkflow/enqueue-repository-deletion.js", () => ({
  enqueueRepositoryDeletionWorkflow: enqueueDeletionMock,
}))

import {
  deleteRepository,
  markRepositoryIndexingReadyWithIssues,
  pruneGithubConnectionRepositoriesNotInGitUrls,
  setRepositoryIndexingStep,
} from "./repositories.js"

const orgId = "org_1"
const githubConnectionId = "con_github"
const orgSlug = "acme"
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
    expect(withGraphClientMock).not.toHaveBeenCalled()
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
    withGraphClientMock.mockImplementation(
      (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
    )
    purgeRepositoryPostgresMock.mockResolvedValue({
      deleted: true,
      alreadyGone: false,
      name: "ctxpipe",
      zoektRepoId: 9,
      stats: {},
      graphEffects: {
        deletedClaimIds: ["c1"],
        refreshedClaimIds: [],
        deletedObjectIds: [],
      },
    })
    applyRepositoryDeletionGraphCleanupMock.mockResolvedValue(undefined)
    notifyCodesearchRepositoryDeletedMock.mockResolvedValue(undefined)
  })

  it("runs Postgres purge inside withOrgDbContext and graph/codesearch after", async () => {
    await deleteRepository({ orgId, orgSlug, repositoryId })

    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      orgId,
      expect.any(Function),
    )
    expect(purgeRepositoryPostgresMock).toHaveBeenCalledWith({
      orgId,
      repositoryId,
    })
    expect(withGraphClientMock).toHaveBeenCalledWith(
      { orgId, orgSlug },
      expect.any(Function),
    )
    expect(applyRepositoryDeletionGraphCleanupMock).toHaveBeenCalledWith({
      repositoryId,
      graphEffects: {
        deletedClaimIds: ["c1"],
        refreshedClaimIds: [],
        deletedObjectIds: [],
      },
    })
    expect(notifyCodesearchRepositoryDeletedMock).toHaveBeenCalledWith({
      orgId,
      repositoryId,
      repoName: "ctxpipe",
      zoektRepoId: 9,
    })
    const graphCallOrder = withGraphClientMock.mock.invocationCallOrder[0]
    if (graphCallOrder === undefined)
      throw new Error("Graph cleanup was not called")
    expect(withOrgDbContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      graphCallOrder,
    )
  })

  it("skips graph/codesearch when the repository is already gone", async () => {
    purgeRepositoryPostgresMock.mockResolvedValue({
      deleted: false,
      alreadyGone: true,
      name: null,
      zoektRepoId: null,
      stats: {},
      graphEffects: {
        deletedClaimIds: [],
        refreshedClaimIds: [],
        deletedObjectIds: [],
      },
    })

    await expect(
      deleteRepository({ orgId, orgSlug, repositoryId }),
    ).resolves.toBe(false)

    expect(withGraphClientMock).not.toHaveBeenCalled()
    expect(notifyCodesearchRepositoryDeletedMock).not.toHaveBeenCalled()
  })
})

describe("markRepositoryIndexingReadyWithIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps indexReady and stores the Zoekt issue", async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    await markRepositoryIndexingReadyWithIssues({
      repositoryId,
      targetHash: "abc123",
      error: new Error("Command failed with exit code 137"),
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        indexingStatus: "complete_with_issues",
        indexReady: true,
        indexingError: "Codebase didn't fit available memory",
        lastIngestedHash: "abc123",
      }),
    )
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
