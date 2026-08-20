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

import { resolveIndexingStep } from "../domain/indexingSteps.js"
import {
  deleteRepository,
  getRepositoryForOrg,
  INDEXING_QUEUED_STALE_MS,
  INDEXING_RUNNING_STALE_MS,
  listRepositoriesForGithubConnection,
  listRepositoriesForOrg,
  markRepositoryIndexingFailed,
  markRepositoryIndexingReadyWithIssues,
  pruneGithubConnectionRepositoriesNotInGitUrls,
  setRepositoryIndexingStep,
  tryClaimRepositoryIndexingEnqueue,
} from "./repositories.js"

const orgId = "org_1"
const githubConnectionId = "con_github"
const orgSlug = "acme"
const repositoryId = "repo_AAAAAAAAAAAAAAAAAAAAAAAAAA"

function mockLinkedRepos(rows: Array<{ id: string; gitUrl: string }>) {
  getOrgDbMock.mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  })
}

function mockRepositoriesWithZoekt(
  rows: Array<Record<string, unknown>>,
  dbMock: typeof getOrgDbMock | typeof getSystemDbMock = getOrgDbMock,
) {
  const where = vi.fn().mockResolvedValue(rows)
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  dbMock.mockReturnValue({ select })
  return { select, from, innerJoin, where }
}

function mockRepositoryWithZoekt(
  row: Record<string, unknown> | null,
  dbMock: typeof getSystemDbMock = getSystemDbMock,
) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : [])
  const where = vi.fn().mockReturnValue({ limit })
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ innerJoin })
  const select = vi.fn().mockReturnValue({ from })
  dbMock.mockReturnValue({ select })
  return { select, from, innerJoin, where, limit }
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

describe("getRepositoryForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("queries system db with org and repository id filters", async () => {
    const row = {
      id: repositoryId,
      orgId,
      name: "acme/app",
      gitUrl: "https://github.com/acme/app.git",
      indexReady: true,
      indexingReason: null,
      lastIngestedHash: "abc123",
      githubConnectionId: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      zoektRepoId: 42,
    }
    const query = mockRepositoryWithZoekt(row)

    await expect(getRepositoryForOrg(orgId, repositoryId)).resolves.toEqual(row)
    expect(getSystemDbMock).toHaveBeenCalledTimes(1)
    expect(query.where).toHaveBeenCalledTimes(1)
    expect(query.limit).toHaveBeenCalledWith(1)
  })

  it("returns null when no row matches (cross-tenant id)", async () => {
    mockRepositoryWithZoekt(null)

    await expect(getRepositoryForOrg(orgId, repositoryId)).resolves.toBeNull()
    expect(getSystemDbMock).toHaveBeenCalledTimes(1)
  })
})

describe("listRepositoriesForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("queries system db filtered by org id", async () => {
    const rows = [
      {
        id: repositoryId,
        orgId,
        name: "acme/app",
        gitUrl: "https://github.com/acme/app.git",
        indexReady: true,
        indexingReason: null,
        lastIngestedHash: null,
        githubConnectionId: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        zoektRepoId: 1,
      },
    ]
    const query = mockRepositoriesWithZoekt(rows, getSystemDbMock)

    await expect(listRepositoriesForOrg(orgId)).resolves.toEqual(rows)
    expect(getSystemDbMock).toHaveBeenCalledTimes(1)
    expect(query.where).toHaveBeenCalledTimes(1)
  })
})

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
    expect(withOrgDbContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      withGraphClientMock.mock.invocationCallOrder[0]!,
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

describe("markRepositoryIndexingFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("stores the memory-fit message instead of fetch failed", async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    await markRepositoryIndexingFailed({
      repositoryId,
      error: new Error("Codebase didn't fit available memory"),
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        indexingStatus: "failed",
        indexingError: "Codebase didn't fit available memory",
        indexReady: false,
      }),
    )
  })

  it("does not remap unrelated fetch failed from non-codesearch work", async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    await markRepositoryIndexingFailed({
      repositoryId,
      error: new TypeError("fetch failed"),
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        indexingStatus: "failed",
        indexingError: "fetch failed",
        indexReady: false,
      }),
    )
  })
})

describe("tryClaimRepositoryIndexingEnqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns true when a row is claimed for enqueue", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: repositoryId }])
    const where = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    await expect(
      tryClaimRepositoryIndexingEnqueue({
        repositoryId,
        reason: "retry",
      }),
    ).resolves.toBe(true)

    const queuedStep = resolveIndexingStep("queued")
    if (!queuedStep) throw new Error("Expected queued step to resolve")
    expect(update).toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        indexingStatus: "queued",
        indexingReason: "retry",
        indexReady: false,
        indexingStep: queuedStep.step,
        indexingStepTotal: queuedStep.total,
        indexingStepKey: queuedStep.key,
      }),
    )
  })

  it("returns false when already queued or running and not stale", async () => {
    const returning = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    await expect(
      tryClaimRepositoryIndexingEnqueue({
        repositoryId,
        reason: null,
      }),
    ).resolves.toBe(false)
  })

  it("uses 30min queued and 6h running stale cutoffs", () => {
    expect(INDEXING_QUEUED_STALE_MS).toBe(30 * 60 * 1000)
    expect(INDEXING_RUNNING_STALE_MS).toBe(6 * 60 * 60 * 1000)
  })

  it("returns true when a stale queued/running row is reclaimed", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: repositoryId }])
    const where = vi.fn().mockReturnValue({ returning })
    const set = vi.fn().mockReturnValue({ where })
    const update = vi.fn().mockReturnValue({ set })
    getOrgDbMock.mockReturnValue({ update })

    const nowMs = Date.parse("2026-07-26T12:00:00.000Z")
    await expect(
      tryClaimRepositoryIndexingEnqueue({
        repositoryId,
        reason: "manual",
        nowMs,
      }),
    ).resolves.toBe(true)

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedAt: new Date(nowMs),
      }),
    )
    expect(where).toHaveBeenCalled()
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
