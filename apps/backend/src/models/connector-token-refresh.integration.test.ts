import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../config/env.js"
import { tryGetOrgDb, withOrgDbContext } from "../db/client.js"
import { connections } from "../db/schema/connections.js"
import {
  encodeNotionTokensForDb,
  encodePagerdutyTokensForDb,
} from "../lib/connection-config.js"
import { seedSourcesOrg } from "../test/workspace-sources-fixture.js"
import {
  notionConnectionToShape,
  pagerdutyConnectionToShape,
} from "./connection-rows.js"
import { refreshNotionConnectionTokensWithLock } from "./notion-connector.js"
import { refreshPagerdutyConnectionTokensWithLock } from "./pagerduty-connector.js"

describe("Notion and PagerDuty token refresh (Postgres)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let notion: string
  let pagerduty: string
  let env: ReturnType<typeof parseEnv>

  beforeAll(async () => {
    seed = await seedSourcesOrg("token_refresh")
    env = parseEnv(process.env)
    notion = await seed.addConnection("notion", {
      ...encodeNotionTokensForDb(
        { accessToken: "old-access", refreshToken: "old-refresh" },
        env,
      ),
    })
    pagerduty = await seed.addConnection("pagerduty", {
      ...encodePagerdutyTokensForDb(
        { accessToken: "old-access", refreshToken: "old-refresh" },
        env,
      ),
      accountId: "pd-account",
      accountName: "Example",
      accountSubdomain: "example",
      region: "us",
      ownerUserId: "user_1",
    })
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  const stored = (id: string) =>
    withOrgDbContext(seed.orgId, async (db) => {
      const [row] = await db
        .select()
        .from(connections)
        .where(eq(connections.id, id))
      if (!row) throw new Error("missing row")
      return row
    })

  it("Notion: refreshes with no SQL transaction open and stores the new tokens", async () => {
    let transactionOpen: boolean | undefined
    const tokens = await refreshNotionConnectionTokensWithLock({
      orgId: seed.orgId,
      connectionId: notion,
      env,
      expectedRefreshToken: "old-refresh",
      expectedAccessToken: "old-access",
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe("old-refresh")
        // The token call must run outside the org transaction.
        transactionOpen = Boolean(tryGetOrgDb())
        return { accessToken: "new-access", refreshToken: "new-refresh" }
      },
    })
    expect(transactionOpen).toBe(false)
    expect(tokens).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    })
    const shape = notionConnectionToShape(await stored(notion), env)
    expect(shape.accessToken).toBe("new-access")
    expect(shape.refreshToken).toBe("new-refresh")
  })

  it("Notion: throws when a caller holds an org transaction", async () => {
    await expect(
      withOrgDbContext(seed.orgId, () =>
        refreshNotionConnectionTokensWithLock({
          orgId: seed.orgId,
          connectionId: notion,
          env,
          expectedRefreshToken: "new-refresh",
          expectedAccessToken: "new-access",
          refresh: async () => ({ accessToken: "x", refreshToken: "y" }),
        }),
      ),
    ).rejects.toThrow("Outbound I/O cannot run inside withOrgDbContext")
  })

  it("PagerDuty: refreshes with no SQL transaction open and stores the new tokens", async () => {
    let transactionOpen: boolean | undefined
    const tokens = await refreshPagerdutyConnectionTokensWithLock({
      orgId: seed.orgId,
      connectionId: pagerduty,
      env,
      expectedRefreshToken: "old-refresh",
      expectedAccessToken: "old-access",
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe("old-refresh")
        transactionOpen = Boolean(tryGetOrgDb())
        return { accessToken: "new-access", refreshToken: "new-refresh" }
      },
    })
    expect(transactionOpen).toBe(false)
    expect(tokens.accessToken).toBe("new-access")
    const shape = pagerdutyConnectionToShape(await stored(pagerduty), env)
    expect(shape.accessToken).toBe("new-access")
    expect(shape.refreshToken).toBe("new-refresh")
  })

  it("PagerDuty: throws when a caller holds an org transaction", async () => {
    await expect(
      withOrgDbContext(seed.orgId, () =>
        refreshPagerdutyConnectionTokensWithLock({
          orgId: seed.orgId,
          connectionId: pagerduty,
          env,
          expectedRefreshToken: "new-refresh",
          expectedAccessToken: "new-access",
          refresh: async () => ({ accessToken: "x", refreshToken: "y" }),
        }),
      ),
    ).rejects.toThrow("Outbound I/O cannot run inside withOrgDbContext")
  })
})
