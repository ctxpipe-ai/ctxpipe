import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"

// The routes import the OpenWorkflow client, which reads DATABASE_URL on import.
let routes: typeof import("./connectors-atlassian.js")
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
// One user per run: the install intent refuses a pending draft of this user
// in another org.
const userId = `user_forge_${Date.now()}_${Math.random().toString(36).slice(2)}`

function createApp() {
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("user", { id: userId } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    c.set("orgId", seed.orgId)
    return withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
      withOrgDbContext(seed.orgId, () => next()),
    )
  })
  app.route(
    "/:orgSlug/api/v1/connectors/atlassian",
    routes.atlassianConnectorRoutes,
  )
  return app
}

async function exists(connectionId: string) {
  const rows = await withOrgDbContext(seed.orgId, (db) =>
    db.select().from(connections).where(eq(connections.id, connectionId)),
  )
  return rows.length > 0
}

describe("Cancel a Confluence setup (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("forge_cancel")
    routes = await import("./connectors-atlassian.js")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  const cancel = (connectionId: string) =>
    createApp().request(
      `/${seed.orgId}/api/v1/connectors/atlassian/installation?connectionId=${connectionId}`,
      { method: "DELETE" },
    )

  it("deletes a draft that only Add Confluence created", async () => {
    const draft = await seed.addConnection("forge", {
      status: "pending",
      provisionStatus: "idle",
      installedByUserId: userId,
    })

    expect((await cancel(draft)).status).toBe(204)
    expect(await exists(draft)).toBe(false)
  })

  it("keeps a draft with an Atlassian app, and an installed connection", async () => {
    // Another user's draft: the install intent below must not reuse it.
    const withApp = await seed.addConnection("forge", {
      status: "pending",
      installedByUserId: `${userId}_other`,
      atlassianOAuthClientId: "client-id",
    })
    const installed = await seed.addConnection("forge", {
      status: "installed",
      cloudId: "cloud-1",
      installationId: "ari:cloud:ecosystem::installation/1",
    })

    for (const connectionId of [withApp, installed]) {
      expect((await cancel(connectionId)).status).toBe(409)
      expect(await exists(connectionId)).toBe(true)
    }
  })

  it("keeps a draft whose Forge install was opened", async () => {
    // "Add Confluence", then "Install" in the setup: the Marketplace can
    // still bind the install to this draft.
    const intent = (query: string) =>
      createApp().request(
        `/${seed.orgId}/api/v1/connectors/atlassian/installation${query}`,
        { method: "POST" },
      )
    const { id } = (await (await intent("")).json()) as { id: string }
    expect((await (await intent("?installOpened=true")).json()).id).toBe(id)

    expect((await cancel(id)).status).toBe(409)
    expect(await exists(id)).toBe(true)
  })
})
