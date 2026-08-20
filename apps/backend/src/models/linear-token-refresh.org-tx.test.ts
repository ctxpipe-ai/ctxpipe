import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../config/env.js"
import { encodeLinearTokensForDb } from "../lib/connection-config.js"

const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const selectRow = vi.hoisted(() => ({
  id: "con_linear",
  orgId: "org_1",
  type: "linear",
  config: {} as Record<string, unknown>,
  createdAt: new Date(),
  updatedAt: new Date(),
}))

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return {
    ...actual,
    assertNotInOrgDbContext: () => {
      if (orgTxDepth.value > 0) {
        throw new Error(
          "Outbound I/O cannot run inside withOrgDbContext; finish the SQL transaction first.",
        )
      }
    },
    withOrgDbContext: async (
      _orgId: string,
      handler: (db: {
        select: () => unknown
        execute: () => Promise<void>
        update: () => unknown
      }) => Promise<unknown>,
    ) => {
      orgTxDepth.value += 1
      try {
        const limit = vi.fn().mockResolvedValue([selectRow])
        const returning = vi.fn().mockResolvedValue([{ id: selectRow.id }])
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
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
        }
        return await handler(tx)
      } finally {
        orgTxDepth.value -= 1
      }
    },
  }
})

import { refreshLinearConnectionTokensWithLock } from "./linear-connector.js"

const env = {
  LINEAR_CLIENT_ID: "id",
  LINEAR_CLIENT_SECRET: "secret",
  AUTH_SECRET: "linear-test-secret-that-is-long-enough",
} as Env

describe("refreshLinearConnectionTokensWithLock", () => {
  beforeEach(() => {
    orgTxDepth.value = 0
    selectRow.config = {
      ...encodeLinearTokensForDb(
        { accessToken: "old-access", refreshToken: "old-refresh" },
        env,
      ),
      accessTokenExpiresAt: null,
      workspaceId: "lin_ws",
      workspaceName: "Acme",
      ownerUserId: "user_1",
    }
  })

  it("runs Linear HTTP refresh outside the org SQL transaction", async () => {
    let refreshInTx = false
    const result = await refreshLinearConnectionTokensWithLock({
      orgId: "org_1",
      connectionId: "con_linear",
      env,
      expectedRefreshToken: "old-refresh",
      expectedAccessToken: "old-access",
      refresh: async () => {
        refreshInTx = orgTxDepth.value > 0
        return {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          accessTokenExpiresAt: null,
        }
      },
    })
    expect(refreshInTx).toBe(false)
    expect(result.accessToken).toBe("new-access")
  })

  it("throws when invoked inside an outer org transaction", async () => {
    const { withOrgDbContext } = await import("../db/client.js")
    await expect(
      withOrgDbContext("org_1", async () =>
        refreshLinearConnectionTokensWithLock({
          orgId: "org_1",
          connectionId: "con_linear",
          env,
          expectedRefreshToken: "old-refresh",
          expectedAccessToken: "old-access",
          refresh: async () => ({
            accessToken: "x",
            refreshToken: "y",
            accessTokenExpiresAt: null,
          }),
        }),
      ),
    ).rejects.toThrow(/Outbound I\/O/)
  })
})
