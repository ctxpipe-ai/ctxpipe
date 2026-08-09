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
  linearScopeSelectionChanged,
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

  it("treats scope ordering as semantically irrelevant", () => {
    const team = {
      externalId: "team-1",
      type: "team" as const,
      title: "Product",
      url: "https://linear.app/acme/team/PRO",
      parentExternalId: null,
      teamId: "team-1",
      teamKey: "PRO",
    }
    const project = {
      externalId: "project-1",
      type: "project" as const,
      title: "Launch",
      url: "https://linear.app/acme/project/launch",
      parentExternalId: "team-1",
      teamId: "team-1",
      teamKey: "PRO",
    }
    const existing = [team, project]

    expect(linearScopeSelectionChanged(existing, [...existing].reverse())).toBe(
      false,
    )
    expect(
      linearScopeSelectionChanged(existing, [
        team,
        { ...project, title: "Launch v2" },
      ]),
    ).toBe(true)
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
