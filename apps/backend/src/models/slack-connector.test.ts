import { beforeEach, describe, expect, it, vi } from "vitest"

const eqMock = vi.hoisted(() =>
  vi.fn((column: unknown, value: unknown) => ({ column, value })),
)
const andMock = vi.hoisted(() =>
  vi.fn((...conditions: unknown[]) => conditions),
)
const limitMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const leftJoinMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const fromMock = vi.hoisted(() =>
  vi.fn(() => ({ leftJoin: leftJoinMock, where: whereMock })),
)
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const returningMock = vi.hoisted(() => vi.fn())
const onConflictDoUpdateMock = vi.hoisted(() =>
  vi.fn(() => ({ returning: returningMock })),
)
const valuesMock = vi.hoisted(() =>
  vi.fn(() => ({
    onConflictDoUpdate: onConflictDoUpdateMock,
    returning: returningMock,
  })),
)
const insertMock = vi.hoisted(() => vi.fn(() => ({ values: valuesMock })))
const getOrgDbMock = vi.hoisted(() =>
  vi.fn(() => ({ select: selectMock, insert: insertMock })),
)

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  and: andMock,
  eq: eqMock,
}))
vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  getSystemDb: vi.fn(),
}))

import {
  bindSlackSyncTargetRepository,
  normalizeSlackSetupPhase,
  SlackRepositoryNotFoundError,
} from "./slack-connector.js"

describe("normalizeSlackSetupPhase", () => {
  it("maps legacy mirror phases to live and everything else to draft", () => {
    expect(normalizeSlackSetupPhase("live")).toBe("live")
    expect(normalizeSlackSetupPhase("awaiting_merge")).toBe("live")
    expect(normalizeSlackSetupPhase("initial_sync")).toBe("live")
    expect(normalizeSlackSetupPhase("sync_failed")).toBe("live")
    expect(normalizeSlackSetupPhase("draft")).toBe("draft")
    expect(normalizeSlackSetupPhase(undefined)).toBe("draft")
  })
})

describe("bindSlackSyncTargetRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("throws when the repository is not found for the org", async () => {
    limitMock.mockResolvedValue([])

    await expect(
      bindSlackSyncTargetRepository({
        orgId: "org_1",
        connectionId: "con_1",
        repositoryId: "repo_missing",
      }),
    ).rejects.toBeInstanceOf(SlackRepositoryNotFoundError)
    expect(insertMock).not.toHaveBeenCalled()
  })

  it("binds the repository and sets the connector live", async () => {
    limitMock.mockResolvedValue([{ id: "repo_1", defaultBranch: "develop" }])
    returningMock.mockResolvedValue([
      {
        id: "sst_1",
        orgId: "org_1",
        connectionId: "con_1",
        repositoryId: "repo_1",
        branch: "develop",
        enabled: true,
        setupPhase: "live",
      },
    ])

    const result = await bindSlackSyncTargetRepository({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
    })

    expect(result.setupPhase).toBe("live")
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_1",
        repositoryId: "repo_1",
        branch: "develop",
        setupPhase: "live",
      }),
    )
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          repositoryId: "repo_1",
          branch: "develop",
          setupPhase: "live",
        }),
      }),
    )
  })

  it("falls back to main when the repository has no default checkout", async () => {
    limitMock.mockResolvedValue([{ id: "repo_1", defaultBranch: null }])
    returningMock.mockResolvedValue([
      {
        id: "sst_1",
        orgId: "org_1",
        connectionId: "con_1",
        repositoryId: "repo_1",
        branch: "main",
        enabled: true,
        setupPhase: "live",
      },
    ])

    const result = await bindSlackSyncTargetRepository({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
    })

    expect(result.branch).toBe("main")
  })

  it("creates a repository from GitHub metadata when it is not registered yet", async () => {
    limitMock.mockResolvedValue([])
    returningMock
      .mockResolvedValueOnce([{ id: "repo_new" }])
      .mockResolvedValueOnce([{ id: "co_1" }])
      .mockResolvedValueOnce([
        {
          id: "sst_1",
          orgId: "org_1",
          connectionId: "con_1",
          repositoryId: "repo_new",
          branch: "main",
          enabled: true,
          setupPhase: "live",
        },
      ])

    const result = await bindSlackSyncTargetRepository({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryName: "acme/ctxpipe-context",
      gitUrl: "https://github.com/acme/ctxpipe-context.git",
      githubConnectionId: "ghc_1",
      branch: "main",
    })

    expect(result.setupPhase).toBe("live")
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "acme/ctxpipe-context",
        gitUrl: "https://github.com/acme/ctxpipe-context.git",
        githubConnectionId: "ghc_1",
      }),
    )
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "con_1",
        setupPhase: "live",
      }),
    )
  })
})
