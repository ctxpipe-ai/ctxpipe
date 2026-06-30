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

import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import {
  ensureGithubConnectionRepositories,
  listRepositoriesForGithubConnection,
  pruneGithubConnectionRepositoriesNotInGitUrls,
} from "./repositories.js"

const orgId = "org_1"
const githubConnectionId = "con_github"
const orgSlug = "acme"
const now = new Date("2026-03-01T00:00:00.000Z")

function repositoryRow(
  overrides: Partial<typeof repositories.$inferSelect> = {},
): typeof repositories.$inferSelect {
  return {
    id: "repo_1",
    orgId,
    name: "acme/alpha",
    gitUrl: "https://github.com/acme/alpha.git",
    indexReady: false,
    indexingReason: null,
    lastIngestedHash: null,
    githubConnectionId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function mockLinkedRepos(rows: Array<{ id: string; gitUrl: string }>) {
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

function mockEnsureRepositoryDb(input?: {
  existingRepository?: typeof repositories.$inferSelect
  existingCheckout?: { zoektRepoId: number }
}) {
  let currentRepository = input?.existingRepository
  let currentCheckout = input?.existingCheckout
  const insertedRepositories: Array<Record<string, unknown>> = []
  const insertedCheckouts: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === repositories)
              return currentRepository ? [currentRepository] : []
            if (table === repositoryCheckouts)
              return currentCheckout ? [currentCheckout] : []
            return []
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table === repositories) {
              insertedRepositories.push(value)
              currentRepository = repositoryRow({
                id: String(value.id),
                orgId: String(value.orgId),
                name: String(value.name),
                gitUrl: String(value.gitUrl),
                githubConnectionId: String(value.githubConnectionId),
              })
              return [currentRepository]
            }
            if (table === repositoryCheckouts) {
              insertedCheckouts.push(value)
              currentCheckout = { zoektRepoId: 42 }
              return [currentCheckout]
            }
            return []
          }),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table !== repositories || !currentRepository) return []
            updates.push(patch)
            currentRepository = {
              ...currentRepository,
              ...patch,
            }
            return [currentRepository]
          }),
        })),
      })),
    })),
  }
  getOrgDbMock.mockReturnValue({
    transaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) =>
      fn(tx),
    ),
  })
  return { insertedRepositories, insertedCheckouts, updates }
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

describe("ensureGithubConnectionRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates selected GitHub repos with a default checkout", async () => {
    const db = mockEnsureRepositoryDb()

    const rows = await ensureGithubConnectionRepositories(
      orgId,
      githubConnectionId,
      [
        {
          name: "acme/alpha",
          gitUrl: "https://github.com/acme/alpha.git",
        },
      ],
    )

    expect(rows).toEqual([
      expect.objectContaining({
        orgId,
        name: "acme/alpha",
        gitUrl: "https://github.com/acme/alpha.git",
        githubConnectionId,
        zoektRepoId: 42,
      }),
    ])
    expect(db.insertedRepositories).toEqual([
      expect.objectContaining({
        orgId,
        name: "acme/alpha",
        gitUrl: "https://github.com/acme/alpha.git",
        githubConnectionId,
      }),
    ])
    expect(db.insertedCheckouts).toEqual([
      expect.objectContaining({
        repositoryId: expect.any(String),
        checkoutKey: "default",
        ref: "main",
      }),
    ])
  })

  it("links an existing repo and reuses its default checkout", async () => {
    const db = mockEnsureRepositoryDb({
      existingRepository: repositoryRow({ githubConnectionId: null }),
      existingCheckout: { zoektRepoId: 7 },
    })

    const rows = await ensureGithubConnectionRepositories(
      orgId,
      githubConnectionId,
      [
        {
          name: "acme/alpha",
          gitUrl: "https://github.com/acme/alpha.git",
        },
      ],
    )

    expect(rows).toEqual([
      expect.objectContaining({
        id: "repo_1",
        githubConnectionId,
        zoektRepoId: 7,
      }),
    ])
    expect(db.insertedRepositories).toEqual([])
    expect(db.insertedCheckouts).toEqual([])
    expect(db.updates).toEqual([
      expect.objectContaining({ githubConnectionId }),
    ])
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
