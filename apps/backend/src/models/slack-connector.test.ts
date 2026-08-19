import { beforeEach, describe, expect, it, vi } from "vitest"

const eqMock = vi.hoisted(() =>
  vi.fn((column: unknown, value: unknown) => ({ column, value })),
)
const andMock = vi.hoisted(() =>
  vi.fn((...conditions: unknown[]) => conditions),
)
const limitMock = vi.hoisted(() => vi.fn())
const orderByMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const whereMock = vi.hoisted(() =>
  vi.fn(() => ({ limit: limitMock, orderBy: orderByMock })),
)
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
  vi.fn(() => {
    const db = { select: selectMock, insert: insertMock }
    return {
      ...db,
      transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
    }
  }),
)
const getSystemDbMock = vi.hoisted(() => vi.fn())

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  and: andMock,
  eq: eqMock,
}))
vi.mock("../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  getSystemDb: getSystemDbMock,
}))

import {
  bindSlackSyncTargetRepository,
  normalizeSlackSetupPhase,
  SlackRepositoryNotFoundError,
  SlackTeamAlreadyConnectedError,
  upsertSlackConnectionFromOAuth,
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

describe("upsertSlackConnectionFromOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects a second organization connecting the same Slack teamId", async () => {
    getSystemDbMock.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  id: "con_other",
                  orgId: "org_other",
                  type: "slack",
                  config: { teamId: "T1", status: "installed" },
                  createdAt: new Date("2026-08-01T00:00:00.000Z"),
                  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
                },
              ],
            }),
          }),
        }),
      }),
    })

    await expect(
      upsertSlackConnectionFromOAuth({
        orgId: "org_1",
        env: { AUTH_SECRET: "a".repeat(32) } as never,
        ownerUserId: "user_1",
        botToken: "xoxb-token",
        teamId: "T1",
      }),
    ).rejects.toBeInstanceOf(SlackTeamAlreadyConnectedError)
    expect(insertMock).not.toHaveBeenCalled()
  })
})
