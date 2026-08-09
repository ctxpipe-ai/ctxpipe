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
  planLinearSyncBindingUpdate,
  type LinearSyncTarget,
} from "./linear-connector.js"

function binding(
  overrides: Partial<LinearSyncTarget> = {},
): LinearSyncTarget {
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
})
