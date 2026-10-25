import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import { encodeLinearTokensForDb } from "../lib/connection-config.js"
import {
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../services/linear/client.js"
import { linearConnectionToShape } from "./connection-rows.js"
import { refreshLinearConnectionTokensWithLock } from "./linear-connector.js"

const env = parseEnv(process.env as Record<string, string | undefined>)

// Linear rotates refresh tokens: each one works once, and reuse gets
// `invalid_grant`. The first token call waits until a second call arrives,
// so both callers read the same stored refresh token before either commits.
let secondCallArrived: () => void = () => {}
const usedRefreshTokens = new Set<string>()
let seed: SeededOrg
let connectionId: string

async function storedShape() {
  const row = await withOrgDbContext(seed.orgId, async (db) => {
    const [found] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
    return found
  })
  if (!row) throw new Error("Linear connection row is missing")
  return linearConnectionToShape(row, env)
}

const server = setupServer(
  http.post("https://api.linear.app/oauth/token", async ({ request }) => {
    const refreshToken =
      new URLSearchParams(await request.text()).get("refresh_token") ?? ""
    if (usedRefreshTokens.has(refreshToken)) {
      secondCallArrived()
      // Send the rejection after the winner stored its tokens.
      while ((await storedShape()).refreshToken === refreshToken) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
    }
    usedRefreshTokens.add(refreshToken)
    await new Promise<void>((resolve) => {
      secondCallArrived = resolve
    })
    return HttpResponse.json({
      access_token: "winner-access",
      refresh_token: "winner-refresh",
      expires_in: 86_399,
      token_type: "Bearer",
      scope: "read",
    })
  }),
)

function refreshOnce() {
  return refreshLinearConnectionTokensWithLock({
    orgId: seed.orgId,
    connectionId,
    env,
    expectedRefreshToken: "stored-refresh",
    expectedAccessToken: "expired-access",
    refresh: async (refreshToken) => {
      const token = await refreshLinearOAuthToken({
        env,
        refreshToken,
        creds: { clientId: "linear-client-id", clientSecret: "secret" },
      })
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? refreshToken,
        accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
      }
    },
  })
}

describe("Linear token refresh with rotating refresh tokens (Postgres + msw)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seed = await seedOrg()
    server.listen({ onUnhandledRequest: "error" })
    connectionId = `con_linear_race_${Date.now().toString(36)}`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(connections).values({
        id: connectionId,
        orgId: seed.orgId,
        type: "linear",
        config: {
          ...encodeLinearTokensForDb(
            { accessToken: "expired-access", refreshToken: "stored-refresh" },
            env,
          ),
          accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          workspaceId: `linear-org-${connectionId}`,
          workspaceName: "Example",
          workspaceUrlKey: "example",
          status: "installed",
        },
      }),
    )
  })

  afterAll(async () => {
    server.close()
    if (seed) await cleanupSeededOrg(seed)
  })

  it("gives the caller that lost the race the tokens the winner stored", async () => {
    const results = await Promise.all([refreshOnce(), refreshOnce()])

    for (const tokens of results) {
      expect(tokens.accessToken).toBe("winner-access")
      expect(tokens.refreshToken).toBe("winner-refresh")
    }
    const stored = await storedShape()
    expect(stored.accessToken).toBe("winner-access")
    expect(stored.refreshToken).toBe("winner-refresh")
  })
})
