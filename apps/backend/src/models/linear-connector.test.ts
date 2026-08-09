import { describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  decodeLinearTokens,
  encodeLinearTokensForDb,
  parseLinearConnectionStored,
  serialiseLinearConnectionConfigForDb,
} from "../lib/connection-config.js"
import {
  claimLinearConfigPrCreation,
  LinearConfigPrCreationInProgressError,
  LinearSyncBindingBusyError,
  markLinearSyncTargetInitialSync,
  planLinearSyncBindingUpdate,
  type LinearSyncTarget,
  withLinearSyncTargetSnapshot,
} from "./linear-connector.js"

const dbMocks = vi.hoisted(() => ({
  getSystemDb: vi.fn(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return { ...actual, getSystemDb: dbMocks.getSystemDb }
})

function binding(overrides: Partial<LinearSyncTarget> = {}): LinearSyncTarget {
  return {
    id: "con_linear",
    orgId: "org_1",
    connectionId: "con_linear",
    repositoryId: "repo_1",
    branch: "main",
    enabled: true,
    setupPhase: "awaiting_merge",
    pendingConfigPullUrl: "https://github.com/acme/context/pull/3",
    pendingConfigPrCreating: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function claimDb(claimedIds: string[]): Db {
  const limit = vi.fn().mockResolvedValue([
    {
      id: "connection-1",
      orgId: "org_1",
      type: "linear",
      config: {
        accessTokenEnc: "enc",
        workspaceId: "workspace-1",
        workspaceName: "Acme",
        ownerUserId: "user-1",
        repositoryId: "repo_1",
        branch: "main",
        enabled: true,
        setupPhase: "draft",
        pendingConfigPullUrl: "https://github.com/example/context/pull/12",
        pendingConfigPrCreating: false,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ])
  const returning = vi.fn().mockResolvedValue(claimedIds.map((id) => ({ id })))
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning })),
      })),
    })),
  } as unknown as Db
}

function linearConnectionRow(setupPhase: LinearSyncTarget["setupPhase"]) {
  return {
    id: "con_linear",
    orgId: "org_1",
    type: "linear",
    config: {
      accessTokenEnc: "enc",
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      ownerUserId: "user-1",
      repositoryId: "repo_1",
      branch: "main",
      enabled: true,
      setupPhase,
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function systemDb(
  setupPhase: LinearSyncTarget["setupPhase"],
  setTransactionActive?: (active: boolean) => void,
): Db {
  const row = linearConnectionRow(setupPhase)
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: row.id }]),
        })),
      })),
    })),
  }
  return {
    transaction: vi.fn(
      async (operation: (transaction: Db) => Promise<unknown>) => {
        setTransactionActive?.(true)
        try {
          return await operation(tx as unknown as Db)
        } finally {
          setTransactionActive?.(false)
        }
      },
    ),
  } as unknown as Db
}

describe("Linear connector model", () => {
  it("encrypts OAuth tokens before serialising connection config", () => {
    const env = {
      AUTH_SECRET: "linear-test-secret-that-is-long-enough",
    } as Env
    const encrypted = encodeLinearTokensForDb(
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      env,
    )
    const stored = serialiseLinearConnectionConfigForDb({
      ...encrypted,
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      ownerUserId: "user-1",
    })

    expect(JSON.stringify(stored)).not.toContain("access-token")
    expect(JSON.stringify(stored)).not.toContain("refresh-token")
    expect(
      decodeLinearTokens(parseLinearConnectionStored(stored), env),
    ).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    })
  })

  it("claims config PR creation only when the compare-and-set update wins", async () => {
    await expect(
      claimLinearConfigPrCreation(claimDb([]), "connection-1"),
    ).rejects.toBeInstanceOf(LinearConfigPrCreationInProgressError)

    await expect(
      claimLinearConfigPrCreation(claimDb(["target-1"]), "connection-1"),
    ).resolves.toEqual({
      pendingConfigPullUrl: "https://github.com/example/context/pull/12",
      setupPhase: "draft",
    })
  })

  it("resets lifecycle when rebinding repository or branch during awaiting_merge", () => {
    const plan = planLinearSyncBindingUpdate({
      existing: binding(),
      repositoryId: "repo_2",
      branch: "main",
      enabled: true,
    })
    expect(plan).toEqual({
      changed: true,
      repositoryOrBranchChanged: true,
      resetLifecycle: true,
      previousConfigPullUrlToClose: "https://github.com/acme/context/pull/3",
      previousRepositoryIdToClose: "repo_1",
    })
  })

  it("keeps lifecycle when only enabled toggles", () => {
    const plan = planLinearSyncBindingUpdate({
      existing: binding({ setupPhase: "live", pendingConfigPullUrl: null }),
      repositoryId: "repo_1",
      branch: "main",
      enabled: false,
    })
    expect(plan).toEqual({
      changed: true,
      repositoryOrBranchChanged: false,
      resetLifecycle: false,
      previousConfigPullUrlToClose: null,
      previousRepositoryIdToClose: null,
    })
  })

  it("refuses rebinding while initial sync is running", () => {
    expect(() =>
      planLinearSyncBindingUpdate({
        existing: binding({
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
        }),
        repositoryId: "repo_2",
        branch: "main",
        enabled: true,
      }),
    ).toThrow(LinearSyncBindingBusyError)
  })

  it("allows rebinding while pendingConfigPrCreating to recover stuck claims", () => {
    const plan = planLinearSyncBindingUpdate({
      existing: binding({ pendingConfigPrCreating: true }),
      repositoryId: "repo_2",
      branch: "main",
      enabled: true,
    })
    expect(plan.resetLifecycle).toBe(true)
  })

  it.each([
    "awaiting_merge",
    "sync_failed",
    "live",
  ] as const)("claims initial sync from %s", async (setupPhase) => {
    dbMocks.getSystemDb.mockReturnValue(systemDb(setupPhase))

    await expect(
      markLinearSyncTargetInitialSync({
        connectionId: "con_linear",
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
    const db = systemDb(setupPhase)
    dbMocks.getSystemDb.mockReturnValue(db)

    await expect(
      markLinearSyncTargetInitialSync({
        connectionId: "con_linear",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("does not claim initial sync when binding is disabled or rebound", async () => {
    const disabled = linearConnectionRow("awaiting_merge")
    disabled.config.enabled = false
    dbMocks.getSystemDb.mockReturnValue({
      transaction: vi.fn(async (operation: (tx: Db) => Promise<unknown>) =>
        operation({
          execute: vi.fn(),
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue([disabled]),
              })),
            })),
          })),
          update: vi.fn(),
        } as unknown as Db),
      ),
    } as unknown as Db)

    await expect(
      markLinearSyncTargetInitialSync({
        connectionId: "con_linear",
        repositoryId: "repo_1",
        branch: "main",
      }),
    ).resolves.toBe(false)

    dbMocks.getSystemDb.mockReturnValue(systemDb("awaiting_merge"))
    await expect(
      markLinearSyncTargetInitialSync({
        connectionId: "con_linear",
        repositoryId: "repo_other",
        branch: "main",
      }),
    ).resolves.toBe(false)
  })

  it("releases the verification transaction before running sync I/O", async () => {
    let transactionActive = false
    const db = systemDb("live", (active) => {
      transactionActive = active
    })
    dbMocks.getSystemDb.mockReturnValue(db)
    const operation = vi.fn(async () => {
      expect(transactionActive).toBe(false)
      return "committed"
    })

    await expect(
      withLinearSyncTargetSnapshot(
        {
          connectionId: "con_linear",
          repositoryId: "repo_1",
          branch: "main",
          setupPhase: "live",
        },
        operation,
      ),
    ).resolves.toBe("committed")
    expect(operation).toHaveBeenCalledOnce()
    // Pre- and post-verify each open a short advisory-lock transaction.
    expect(db.transaction).toHaveBeenCalledTimes(2)
  })
})
