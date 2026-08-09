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
} from "./linear-connector.js"

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
})
