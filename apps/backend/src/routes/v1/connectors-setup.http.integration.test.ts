import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq, sql } from "drizzle-orm"
import { evlog } from "evlog/hono"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  type ConnectionType,
  connections,
} from "../../db/schema/connections.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

describe("connector setup first screens (Postgres)", () => {
  let seed: SeededOrg
  // Self-host shape: no deployment OAuth apps, so setup starts on a draft row.
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    PAGERDUTY_CLIENT_ID: undefined,
    PAGERDUTY_CLIENT_SECRET: undefined,
    NOTION_CLIENT_ID: undefined,
    NOTION_CLIENT_SECRET: undefined,
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerV1Routes(app)
    return app
  }

  function call(method: "GET" | "POST", path: string, orgSlug = seed.orgSlug) {
    return createApp().request(
      `http://backend.test/${orgSlug}/api/v1/connectors${path}`,
      { method, headers: { cookie: seed.cookie } },
    )
  }

  async function listedTypes() {
    const res = await call("GET", "")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { type: string }[] }
    return body.items.map((item) => item.type).sort()
  }

  /** Opens the first screen of each self-host setup wizard. */
  async function openEveryFirstScreen() {
    expect((await call("POST", "/atlassian/installation")).status).toBe(200)
    expect((await call("POST", "/notion/draft")).status).toBe(200)
    expect((await call("POST", "/linear/draft")).status).toBe(200)
    expect((await call("POST", "/pagerduty/setup")).status).toBe(200)
  }

  async function patchConfig(
    orgId: string,
    type: ConnectionType,
    patch: Record<string, unknown>,
  ) {
    await withOrgDbContext(orgId, (db) =>
      db
        .update(connections)
        .set({
          config: sql`${connections.config} || ${JSON.stringify(patch)}::jsonb`,
        })
        .where(and(eq(connections.orgId, orgId), eq(connections.type, type))),
    )
  }

  async function connectionIds(orgId: string, type: ConnectionType) {
    const rows = await withOrgDbContext(orgId, (db) =>
      db
        .select({ id: connections.id, config: connections.config })
        .from(connections)
        .where(and(eq(connections.orgId, orgId), eq(connections.type, type))),
    )
    return rows
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seed = await seedOrg()
  })

  afterEach(async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, seed.orgId)),
    )
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  it("starts self-hosted PagerDuty setup on a draft connection", async () => {
    const first = await call("POST", "/pagerduty/setup")
    expect(first.status).toBe(200)
    const { connectionId } = (await first.json()) as { connectionId: string }
    expect(connectionId).toMatch(/^con_/)

    const again = await call("POST", "/pagerduty/setup")
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ connectionId })
  })

  it("does not list a Notion, Linear, or PagerDuty draft that only opened a setup first screen", async () => {
    expect((await call("POST", "/notion/draft")).status).toBe(200)
    expect((await call("POST", "/linear/draft")).status).toBe(200)
    expect((await call("POST", "/pagerduty/setup")).status).toBe(200)

    expect(await listedTypes()).toEqual([])
  })

  it("lists a pending Confluence draft, so the user can finish or remove it", async () => {
    expect((await call("POST", "/atlassian/installation")).status).toBe(200)

    expect(await listedTypes()).toEqual(["forge"])
  })

  it("lists a setup draft that holds saved progress", async () => {
    await openEveryFirstScreen()
    const progress: [ConnectionType, Record<string, unknown>][] = [
      ["forge", { atlassianOAuthClientId: "atlassian-client-1" }],
      ["notion", { oauthClientId: "notion-client-1" }],
      ["linear", { oauthClientId: "linear-client-1" }],
      ["pagerduty", { oauthClientId: "pagerduty-client-1" }],
    ]
    for (const [type, patch] of progress) {
      await patchConfig(seed.orgId, type, patch)
    }

    expect(await listedTypes()).toEqual([
      "forge",
      "linear",
      "notion",
      "pagerduty",
    ])
  })

  it("lists a connection once its provider account is linked", async () => {
    await openEveryFirstScreen()
    const linked: [ConnectionType, Record<string, unknown>][] = [
      ["forge", { cloudId: "cloud-1" }],
      ["notion", { workspaceId: "notion-ws-1" }],
      ["linear", { workspaceId: "linear-ws-1" }],
      ["pagerduty", { accountId: "PD-ACCOUNT-1" }],
    ]
    for (const [type, patch] of linked) {
      await patchConfig(seed.orgId, type, patch)
    }

    expect(await listedTypes()).toEqual([
      "forge",
      "linear",
      "notion",
      "pagerduty",
    ])
  })

  it("keeps the saved state of a Confluence draft when setup starts again", async () => {
    expect((await call("POST", "/atlassian/installation")).status).toBe(200)
    await patchConfig(seed.orgId, "forge", {
      atlassianOAuthClientId: "atlassian-client-1",
    })

    expect((await call("POST", "/atlassian/installation")).status).toBe(200)

    const rows = await connectionIds(seed.orgId, "forge")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.config).toMatchObject({
      atlassianOAuthClientId: "atlassian-client-1",
    })
  })

  describe("with a Confluence draft in another organization", () => {
    let otherOrg: { id: string; slug: string }

    beforeAll(async () => {
      const org = await getAuth().api.createOrganization({
        body: {
          name: `Other ${seed.orgSlug}`,
          slug: `other-${seed.orgSlug}`,
        },
        headers: new Headers({
          origin: process.env.AUTH_BASE_URL ?? "http://localhost:3000",
          cookie: seed.cookie,
        }),
      })
      if (!org?.id) throw new Error("createOrganization returned no id")
      otherOrg = { id: org.id, slug: org.slug }
    })

    afterEach(async () => {
      await withOrgDbContext(otherOrg.id, (db) =>
        db.delete(connections).where(eq(connections.orgId, otherOrg.id)),
      )
    })

    afterAll(async () => {
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, otherOrg.id))
    })

    it("refuses while the other organization has a pending draft", async () => {
      expect(
        (await call("POST", "/atlassian/installation", otherOrg.slug)).status,
      ).toBe(200)

      const res = await call("POST", "/atlassian/installation")
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        code: "atlassian_pending_installation_exists",
      })
      expect(await connectionIds(otherOrg.id, "forge")).toHaveLength(1)
      expect(await connectionIds(seed.orgId, "forge")).toEqual([])
    })

    it("refuses while the other organization's draft holds progress", async () => {
      expect(
        (await call("POST", "/atlassian/installation", otherOrg.slug)).status,
      ).toBe(200)
      await patchConfig(otherOrg.id, "forge", {
        confluenceSiteHost: "example.atlassian.net",
      })

      const res = await call("POST", "/atlassian/installation")
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        code: "atlassian_pending_installation_exists",
      })
      expect(await connectionIds(otherOrg.id, "forge")).toHaveLength(1)
    })
  })
})
