import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import type { Db } from "../db/client.js"
import {
  decodeLinearTokens,
  encodeLinearTokensForDb,
  parseLinearConnectionStored,
  serialiseLinearConnectionConfigForDb,
} from "../lib/connection-config.js"
import {
  type LinearBinding,
  LinearSyncBindingBusyError,
  planLinearSyncBindingUpdate,
  withLinearBindingSnapshot,
} from "./linear-connector.js"

const dbMocks = vi.hoisted(() => ({
  getSystemDb: vi.fn(),
  getConnectionDirectoryByConnectionId: vi.fn(),
  upsertConnectionDirectory: vi.fn(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return {
    ...actual,
    getSystemDb: dbMocks.getSystemDb,
    withOrgDbContext: async (
      _orgId: string,
      fn: (db: Db) => Promise<unknown>,
    ) => {
      const db = dbMocks.getSystemDb()
      return db.transaction(fn)
    },
  }
})

vi.mock("./connection-directory.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./connection-directory.js")>()
  return {
    ...actual,
    getConnectionDirectoryByConnectionId:
      dbMocks.getConnectionDirectoryByConnectionId,
    upsertConnectionDirectory: dbMocks.upsertConnectionDirectory,
  }
})

function binding(overrides: Partial<LinearBinding> = {}): LinearBinding {
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

function linearConnectionRow(setupPhase: LinearBinding["setupPhase"]) {
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
  setupPhase: LinearBinding["setupPhase"],
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
  beforeEach(() => {
    dbMocks.getConnectionDirectoryByConnectionId.mockResolvedValue({
      connectionId: "con_linear",
      orgId: "org_1",
      type: "linear",
    })
    dbMocks.upsertConnectionDirectory.mockResolvedValue(undefined)
  })

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
      withLinearBindingSnapshot(
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
