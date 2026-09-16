import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  encodePagerdutyTokensForDb,
  type PagerdutySetupPhase,
} from "../lib/connection-config.js"
import {
  claimPagerdutyBindingInitialSync,
  clearPagerdutySyncBindingsForRepository,
  finalizePagerdutyBindingAfterContentWorkflow,
  planPagerdutySyncBindingUpdate,
  refreshPagerdutyConnectionTokensWithLock,
  upsertPagerdutyConnectionFromOAuth,
} from "./pagerduty-connector.js"

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

function pagerdutyConnectionRow(
  setupPhase: PagerdutySetupPhase,
  overrides: { enabled?: boolean; repositoryId?: string; branch?: string } = {},
) {
  return {
    id: "con_pagerduty",
    orgId: "org_1",
    type: "pagerduty",
    config: {
      ...encodePagerdutyTokensForDb(
        { accessToken: "access-old", refreshToken: "refresh-old" },
        env,
      ),
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      ownerUserId: "user_1",
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
  setupPhase: PagerdutySetupPhase,
  overrides?: { enabled?: boolean; repositoryId?: string; branch?: string },
) {
  const row = pagerdutyConnectionRow(setupPhase, overrides)
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

describe("planPagerdutySyncBindingUpdate", () => {
  it("resets lifecycle when the repository or branch changes", () => {
    expect(
      planPagerdutySyncBindingUpdate({
        existing: {
          id: "con_pagerduty",
          orgId: "org_1",
          connectionId: "con_pagerduty",
          repositoryId: "repo_1",
          branch: "main",
          enabled: true,
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        repositoryId: "repo_2",
        branch: "main",
        enabled: true,
      }),
    ).toEqual({
      changed: true,
      repositoryOrBranchChanged: true,
      resetLifecycle: true,
    })
  })
})

describe("PagerDuty connector lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(["awaiting_merge", "sync_failed", "live"] as const)(
    "claims initial sync from %s",
    async (setupPhase) => {
      const { db } = systemDb(setupPhase)
      dbMocks.getSystemDb.mockReturnValue(db)

      await expect(
        claimPagerdutyBindingInitialSync({
          connectionId: "con_pagerduty",
          repositoryId: "repo_1",
          branch: "main",
        }),
      ).resolves.toBe(true)
    },
  )

  it.each(["draft", "config_failed", "initial_sync"] as const)(
    "does not claim initial sync from %s",
    async (setupPhase) => {
      const { db } = systemDb(setupPhase)
      dbMocks.getSystemDb.mockReturnValue(db)

      await expect(
        claimPagerdutyBindingInitialSync({
          connectionId: "con_pagerduty",
          repositoryId: "repo_1",
          branch: "main",
        }),
      ).resolves.toBe(false)
    },
  )

  it("finalizes completed content sync as live", async () => {
    const { db, set } = systemDb("initial_sync")
    dbMocks.getSystemDb.mockReturnValue(db)

    await finalizePagerdutyBindingAfterContentWorkflow({
      connectionId: "con_pagerduty",
      workflowStatus: "completed",
    })

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })
})

describe("PagerDuty connection storage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("locks OAuth upserts and preserves the latest binding", async () => {
    const matched = {
      ...pagerdutyConnectionRow("live", {
        repositoryId: "repo_old",
        branch: "main",
      }),
      config: {
        ...pagerdutyConnectionRow("live", {
          repositoryId: "repo_old",
          branch: "main",
        }).config,
        webhookSubscriptionId: "PFXXXX",
        webhookSecretEnc: "ctxv1:keep",
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

    const result = await upsertPagerdutyConnectionFromOAuth({
      orgId: "org_1",
      env,
      ownerUserId: "user_1",
      accessToken: "new_access",
      refreshToken: "new_refresh",
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: "user_pd",
    })

    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: "repo_rebound",
          branch: "release",
          webhookSubscriptionId: "PFXXXX",
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

  it("serialises stale refreshes", async () => {
    const storedRow = pagerdutyConnectionRow("live", {
      repositoryId: "repo_rebound",
      branch: "release",
    })
    let row: Omit<typeof storedRow, "config"> & {
      config: Record<string, unknown>
    } = {
      ...storedRow,
      config: {
        ...storedRow.config,
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
      accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
    }))

    const results = await Promise.all([
      refreshPagerdutyConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_pagerduty",
        env,
        expectedRefreshToken: "refresh-old",
        expectedAccessToken: "access-old",
        refresh,
      }),
      refreshPagerdutyConnectionTokensWithLock({
        orgId: "org_1",
        connectionId: "con_pagerduty",
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
        accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      },
      {
        accessToken: "access-fresh",
        refreshToken: "refresh-rotated",
        accessTokenExpiresAt: "2026-09-15T00:00:00.000Z",
      },
    ])
  })

  it("clears every binding for a deleted repository", async () => {
    const row = pagerdutyConnectionRow("live")
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
            .mockResolvedValue([{ id: row.id }, { id: "con_pagerduty_2" }]),
        })),
      })),
      transaction: vi.fn((operation: (transaction: Db) => Promise<unknown>) =>
        operation(tx as unknown as Db),
      ),
    } as unknown as Db
    dbMocks.getOrgDb.mockReturnValue(db)

    await expect(
      clearPagerdutySyncBindingsForRepository({
        orgId: "org_1",
        repositoryId: "repo_1",
      }),
    ).resolves.toBe(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          repositoryId: null,
          branch: null,
          enabled: false,
          setupPhase: "draft",
        }),
      }),
    )
  })
})
