import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import type { NotionSetupPhase } from "../lib/connection-config.js"
import {
  claimNotionBindingInitialSync,
  clearNotionSyncBindingsForRepository,
  finalizeNotionBindingAfterContentWorkflow,
  getNotionConnectionByConnectionId,
  refreshNotionConnectionTokensWithLock,
  upsertNotionConnectionFromOAuth,
} from "./notion-connector.js"

const dbMocks = vi.hoisted(() => ({
  getOrgDb: vi.fn(),
  getSystemDb: vi.fn(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return {
    ...actual,
    getOrgDb: dbMocks.getOrgDb,
    getSystemDb: dbMocks.getSystemDb,
  }
})

const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
} as unknown as Env

function notionConnectionRow(
  setupPhase: NotionSetupPhase,
  overrides: { enabled?: boolean; repositoryId?: string; branch?: string } = {},
) {
  return {
    id: "con_notion",
    orgId: "org_1",
    type: "notion",
    config: {
      repositoryId: overrides.repositoryId ?? "repo_1",
      branch: overrides.branch ?? "main",
      enabled: overrides.enabled ?? true,
      setupPhase,
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function systemDb(
  setupPhase: NotionSetupPhase,
  overrides?: { enabled?: boolean; repositoryId?: string; branch?: string },
) {
  const row = notionConnectionRow(setupPhase, overrides)
  const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
    where: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: row.id }]),
    })),
  }))
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set })),
  }
  const db = {
    transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
      operation(tx as unknown as Db),
    ),
  } as unknown as Db
  return { db, set }
}

describe("Notion connector lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    "awaiting_merge",
    "sync_failed",
    "live",
  ] as const)("claims initial sync from %s", async (setupPhase) => {
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(true)
  })

  it.each([
    "draft",
    "config_failed",
    "initial_sync",
  ] as const)("does not claim initial sync from %s", async (setupPhase) => {
    const { db } = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("does not claim a disabled or rebound binding", async () => {
    const disabled = systemDb("awaiting_merge", { enabled: false })
    dbMocks.getSystemDb.mockReturnValue(disabled.db)
    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)

    const rebound = systemDb("awaiting_merge")
    dbMocks.getSystemDb.mockReturnValue(rebound.db)
    await expect(
      claimNotionBindingInitialSync({
        connectionId: "con_notion",
        repositoryId: "repo_other",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it.each([
    "failed",
    "partial_failed",
  ] as const)("finalizes %s content sync as sync_failed", async (workflowStatus) => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      finalizeNotionBindingAfterContentWorkflow({
        connectionId: "con_notion",
        workflowStatus,
      }),
    ).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })

  it("finalizes completed content sync as live", async () => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await finalizeNotionBindingAfterContentWorkflow({
      connectionId: "con_notion",
      workflowStatus: "completed",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })
})

describe("Notion connection storage maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("locks OAuth upserts and preserves the latest binding", async () => {
    const matched = {
      ...notionConnectionRow("live", {
        repositoryId: "repo_old",
        branch: "main",
      }),
      config: {
        ...notionConnectionRow("live", {
          repositoryId: "repo_old",
          branch: "main",
        }).config,
        accessToken: "old_access",
        refreshToken: "old_refresh",
        botId: "bot_1",
        workspaceId: "workspace_1",
        ownerUserId: "user_1",
        status: "installed",
      },
    }
    const latest = {
      ...matched,
      config: {
        ...matched.config,
        repositoryId: "repo_rebound",
        branch: "release",
      },
    }
    let updatedConfig: Record<string, unknown> | undefined
    const returning = vi.fn(async () => [
      { ...latest, config: updatedConfig ?? latest.config },
    ])
    const set = vi.fn((value: { config: Record<string, unknown> }) => {
      updatedConfig = value.config
      return { where: vi.fn(() => ({ returning })) }
    })
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([matched]),
            })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([latest]),
          })),
        })),
      })
    const tx = {
      execute: vi.fn(),
      select,
      update: vi.fn(() => ({ set })),
    }
    const db = {
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const result = await upsertNotionConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      botId: "bot_1",
      workspaceId: "workspace_1",
      workspaceName: "Workspace",
    })

    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: "repo_rebound",
          branch: "release",
        }),
      }),
    )
    expect(result).toMatchObject({
      accessToken: "new_access",
      refreshToken: "new_refresh",
      repositoryId: "repo_rebound",
      branch: "release",
    })
  })

  it("rewrites legacy plaintext tokens after reading a connection", async () => {
    const row = {
      ...notionConnectionRow("draft"),
      config: {
        ...notionConnectionRow("draft").config,
        accessToken: "legacy_access",
        refreshToken: "legacy_refresh",
      },
    }
    const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
      where: vi.fn().mockResolvedValue(undefined),
    }))
    const selectRow = () => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })
    const tx = {
      execute: vi.fn(),
      select: vi.fn(selectRow),
      update: vi.fn(() => ({ set })),
    }
    const db = {
      select: vi.fn(selectRow),
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    const result = await getNotionConnectionByConnectionId(
      "org_1",
      "con_notion",
      env,
    )

    expect(result?.accessToken).toBe("legacy_access")
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          accessTokenEnc: expect.stringMatching(/^ctxv1:/),
          refreshTokenEnc: expect.stringMatching(/^ctxv1:/),
        }),
      }),
    )
    const persisted = set.mock.calls[0]?.[0].config
    expect(persisted).not.toHaveProperty("accessToken")
    expect(persisted).not.toHaveProperty("refreshToken")
  })

  it("serialises stale refreshes and preserves the locked binding config", async () => {
    const storedRow = notionConnectionRow("live", {
      repositoryId: "repo_rebound",
      branch: "release",
    })
    let row: Omit<typeof storedRow, "config"> & {
      config: Record<string, unknown>
    } = {
      ...storedRow,
      config: {
        ...storedRow.config,
        accessToken: "access-old",
        refreshToken: "refresh-old",
      },
    }
    const set = vi.fn((value: { config: Record<string, unknown> }) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          row = { ...row, config: value.config, updatedAt: new Date() }
          return [{ id: row.id }]
        }),
      })),
    }))
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [row]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    }
    let transactionTail = Promise.resolve()
    const db = {
      transaction: vi.fn(
        <T>(operation: (transaction: Db) => Promise<T>): Promise<T> => {
          const result = transactionTail.then(() =>
            operation(tx as unknown as Db),
          )
          transactionTail = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        },
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)
    const refresh = vi.fn(async () => ({
      accessToken: "access-fresh",
      refreshToken: "refresh-rotated",
    }))

    const results = await Promise.all([
      refreshNotionConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_notion",
        env,
        expectedRefreshToken: "refresh-old",
        expectedAccessToken: "access-old",
        refresh,
      }),
      refreshNotionConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_notion",
        env,
        expectedRefreshToken: "refresh-old",
        expectedAccessToken: "access-old",
        refresh,
      }),
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
      },
      {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
      },
    ])
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      config: expect.objectContaining({
        repositoryId: "repo_rebound",
        branch: "release",
      }),
      updatedAt: expect.any(Date),
    })
  })

  it("clears every binding for a deleted repository", async () => {
    const row = {
      ...notionConnectionRow("live"),
      config: {
        ...notionConnectionRow("live").config,
        pendingConfigPullUrl: "https://github.com/acme/repo/pull/1",
        pendingConfigPrCreating: true,
      },
    }
    const set = vi.fn((_value: { config: Record<string, unknown> }) => ({
      where: vi.fn().mockResolvedValue(undefined),
    }))
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([row]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    }
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi
            .fn()
            .mockResolvedValue([{ id: row.id }, { id: "con_notion_2" }]),
        })),
      })),
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      clearNotionSyncBindingsForRepository({
        orgId: "org_1",
        repositoryId: "repo_1",
      }),
    ).resolves.toBe(2)
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: null,
          branch: null,
          enabled: false,
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        }),
      }),
    )
  })
})
