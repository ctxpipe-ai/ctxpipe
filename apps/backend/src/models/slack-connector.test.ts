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
const valuesMock = vi.hoisted(() =>
  vi.fn(() => ({
    returning: returningMock,
  })),
)
const insertMock = vi.hoisted(() => vi.fn(() => ({ values: valuesMock })))
const whereUpdateMock = vi.hoisted(() =>
  vi.fn(() => ({ returning: returningMock })),
)
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereUpdateMock })))
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })))
const getOrgDbMock = vi.hoisted(() =>
  vi.fn(() => {
    const db = {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
    }
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
    tryGetOrgDb: () => ({}),
    tryGetOrgDbOrgId: () => "org_test",
    assertNotInOrgDbContext: () => undefined,

  getOrgDb: getOrgDbMock,
  getSystemDb: getSystemDbMock,
}))

import {
  bindSlackSyncTargetRepository,
  derivedSlackSetupPhase,
  SlackRepositoryNotFoundError,
  SlackTeamAlreadyConnectedError,
  upsertSlackConnectionFromOAuth,
} from "./slack-connector.js"

const now = new Date("2026-08-01T00:00:00.000Z")
const slackConnectionRow = {
  id: "con_1",
  orgId: "org_1",
  type: "slack" as const,
  config: {
    teamId: "T1",
    status: "installed",
    enabled: true,
  },
  createdAt: now,
  updatedAt: now,
}

describe("derivedSlackSetupPhase", () => {
  it("is live only when a repository is bound and capture is enabled", () => {
    expect(
      derivedSlackSetupPhase({ repositoryId: "repo_1", enabled: true }),
    ).toBe("live")
    expect(
      derivedSlackSetupPhase({ repositoryId: "repo_1", enabled: false }),
    ).toBe("draft")
    expect(derivedSlackSetupPhase({ repositoryId: null, enabled: true })).toBe(
      "draft",
    )
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
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("binds the repository on connections.config and reports live", async () => {
    limitMock
      .mockResolvedValueOnce([{ id: "repo_1", defaultBranch: "develop" }])
      .mockResolvedValueOnce([slackConnectionRow])
    returningMock.mockResolvedValue([
      {
        ...slackConnectionRow,
        config: {
          ...slackConnectionRow.config,
          repositoryId: "repo_1",
          branch: "develop",
          enabled: true,
        },
      },
    ])

    const result = await bindSlackSyncTargetRepository({
      orgId: "org_1",
      connectionId: "con_1",
      repositoryId: "repo_1",
    })

    expect(result.setupPhase).toBe("live")
    expect(result.repositoryId).toBe("repo_1")
    expect(result.branch).toBe("develop")
    expect(result.repositoryIngestion).toBeUndefined()
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: "repo_1",
          branch: "develop",
          enabled: true,
        }),
      }),
    )
  })

  it("falls back to main when the repository has no default checkout", async () => {
    limitMock
      .mockResolvedValueOnce([{ id: "repo_1", defaultBranch: null }])
      .mockResolvedValueOnce([slackConnectionRow])
    returningMock.mockResolvedValue([
      {
        ...slackConnectionRow,
        config: {
          ...slackConnectionRow.config,
          repositoryId: "repo_1",
          branch: "main",
          enabled: true,
        },
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
    limitMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([slackConnectionRow])
    returningMock
      .mockResolvedValueOnce([{ id: "repo_new" }])
      .mockResolvedValueOnce([{ id: "co_1" }])
      .mockResolvedValueOnce([
        {
          ...slackConnectionRow,
          config: {
            ...slackConnectionRow.config,
            repositoryId: "repo_created",
            branch: "main",
            enabled: true,
          },
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
    expect(result.repositoryIngestion).toEqual(
      expect.objectContaining({
        orgId: "org_1",
        targetBranch: "main",
      }),
    )
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "acme/ctxpipe-context",
        gitUrl: "https://github.com/acme/ctxpipe-context.git",
        githubConnectionId: "ghc_1",
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
