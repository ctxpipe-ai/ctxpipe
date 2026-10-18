import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
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
import { parseEnv } from "../../config/env.js"
import { getSystemDb, initDb, withOrgDbContext } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import {
  connectionDirectory,
  connections,
} from "../../db/schema/connections.js"
import { PLAIN_REQUIRED_PERMISSIONS } from "../../domain/workspace-sources/providers/plain.js"
import {
  getPlainWebhookTarget,
  savePlainWebhookTarget,
} from "../../models/plain-connector.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at
// import time.
vi.hoisted(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
})

const GOOD_KEY = "plainApiKey_good_fixture"

/** The Plain workspace that msw serves. */
const pl = {
  workspaceId: "w_1",
  /** A message to refuse the next webhook target with. */
  refuseTarget: null as string | null,
  createdTargets: [] as Array<{
    url: string
    headers: Array<{ name: string; value: string }>
  }>,
  deletedTargets: [] as string[],
}

const page = <T>(nodes: T[]) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage: false, endCursor: null },
})

const server = setupServer(
  http.post("https://core-api.uk.plain.com/graphql/v1", async ({ request }) => {
    if (request.headers.get("authorization") !== `Bearer ${GOOD_KEY}`)
      return new HttpResponse(null, { status: 401 })
    const { operationName, variables } = (await request.json()) as {
      operationName: string
      variables: Record<string, unknown>
    }
    const data = (() => {
      switch (operationName) {
        case "PlainAccess":
          return {
            myWorkspace: { id: pl.workspaceId, name: "Acme Support" },
            myPermissions: { permissions: PLAIN_REQUIRED_PERMISSIONS },
          }
        case "PlainCreateWebhookTarget": {
          if (pl.refuseTarget)
            return {
              createWebhookTarget: {
                webhookTarget: null,
                error: { message: pl.refuseTarget },
              },
            }
          const input = variables.input as (typeof pl.createdTargets)[number]
          pl.createdTargets.push(input)
          return {
            createWebhookTarget: {
              webhookTarget: { id: `wht_${pl.createdTargets.length}` },
              error: null,
            },
          }
        }
        case "PlainDeleteWebhookTarget":
          pl.deletedTargets.push(String(variables.webhookTargetId))
          return { deleteWebhookTarget: { error: null } }
        case "PlainHelpCenters":
          return {
            helpCenters: page([
              { id: "hc_1", internalName: "Docs", isDeleted: false },
            ]),
          }
        case "PlainLabelTypes":
          return { labelTypes: page([{ id: "lt_1", name: "Bug" }]) }
        default:
          throw new Error(`Unexpected ${operationName}`)
      }
    })()
    return HttpResponse.json({ data })
  }),
)

describe("Plain connector routes (Postgres + msw)", () => {
  let seed: SeededOrg
  let otherSeed: SeededOrg
  const env = parseEnv(process.env as Record<string, string | undefined>)

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use(withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("user", null)
      c.set("session", null)
      c.set("oauthReferenceId", null)
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

  const request = (
    path: string,
    init: RequestInit = {},
    as: SeededOrg = seed,
  ) =>
    createApp().request(
      `http://backend.test/${as.orgSlug}/api/v1/connectors${path}`,
      {
        ...init,
        headers: {
          cookie: as.cookie,
          "content-type": "application/json",
          ...init.headers,
        },
      },
    )

  const connect = (body: Record<string, unknown>) =>
    request("/plain", { method: "POST", body: JSON.stringify(body) })

  const connected = async () => {
    const res = await connect({ apiKey: GOOD_KEY })
    expect(res.status).toBe(200)
    return (await res.json()) as { connectionId: string }
  }

  const status = async (connectionId: string) =>
    (await (
      await request(`/plain/status?connectionId=${connectionId}`)
    ).json()) as Record<string, unknown>

  async function storedConfig(connectionId: string) {
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ config: connections.config })
        .from(connections)
        .where(eq(connections.id, connectionId)),
    )
    return row?.config
  }

  const connectionCount = async () =>
    (
      await withOrgDbContext(seed.orgId, (db) =>
        db.select().from(connections).where(eq(connections.orgId, seed.orgId)),
      )
    ).length

  async function setRole(role: string) {
    await getSystemDb()
      .update(members)
      .set({ role })
      .where(
        and(
          eq(members.organizationId, seed.orgId),
          eq(members.userId, seed.userId),
        ),
      )
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    server.listen({ onUnhandledRequest: "bypass" })
    seed = await seedOrg()
    otherSeed = await seedOrg()
  })
  afterEach(() => {
    server.resetHandlers()
    pl.workspaceId = "w_1"
    pl.refuseTarget = null
    pl.createdTargets.length = 0
    pl.deletedTargets.length = 0
  })
  afterAll(async () => {
    server.close()
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(connections).where(eq(connections.orgId, seed.orgId)),
    )
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, seed.orgId))
    for (const cleaned of [otherSeed, seed]) {
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      if (cleaned) await cleanupSeededOrg(cleaned)
    }
    vi.unstubAllEnvs()
  })

  it("connects with a checked key, creates the webhook target, and stores the secrets encrypted", async () => {
    const { connectionId } = await connected()

    expect(pl.createdTargets).toHaveLength(1)
    const target = pl.createdTargets[0]
    expect(target?.url).toBe(
      `${env.AUTH_BASE_URL.replace(/\/$/, "")}/api/v1/webhook/plain/${connectionId}`,
    )
    // The webhook route reads the same token that Plain sends.
    const token = target?.headers[0]?.value ?? ""
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect((await getPlainWebhookTarget(connectionId, env))?.webhookToken).toBe(
      token,
    )
    const stored = JSON.stringify(await storedConfig(connectionId))
    expect(stored).not.toContain(GOOD_KEY)
    expect(stored).not.toContain(token)
    const list = (await (await request("")).json()) as {
      items: Array<{ id: string; type: string; displayName: string | null }>
    }
    expect(list.items).toContainEqual(
      expect.objectContaining({
        id: connectionId,
        type: "plain",
        displayName: "Acme Support",
      }),
    )
    expect(await status(connectionId)).toEqual({
      status: "installed",
      workspaceName: "Acme Support",
      webhookConfigured: true,
    })
  })

  it("gives the reason for a refused key, and saves nothing", async () => {
    const before = await connectionCount()

    const res = await connect({ apiKey: "bad" })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Plain does not accept this API key",
    })
    expect(await connectionCount()).toBe(before)
    expect(pl.createdTargets).toEqual([])
  })

  it("connects without live updates when Plain refuses the webhook target", async () => {
    // For example, a self-hosted ctx| that Plain cannot reach.
    pl.refuseTarget = "The URL must be public"

    const { connectionId } = await connected()

    expect(await status(connectionId)).toMatchObject({
      status: "installed",
      webhookConfigured: false,
    })

    // A reconnect tries again.
    pl.refuseTarget = null
    expect((await connect({ connectionId, apiKey: GOOD_KEY })).status).toBe(200)
    expect(await status(connectionId)).toMatchObject({
      webhookConfigured: true,
    })
  })

  it("replaces the webhook target on a reconnect, and refuses another workspace", async () => {
    // A target that a Plain admin deleted, or an old URL, heals on a reconnect.
    const { connectionId } = await connected()

    expect((await connect({ connectionId, apiKey: GOOD_KEY })).status).toBe(200)

    expect(pl.createdTargets).toHaveLength(2)
    expect(pl.deletedTargets).toEqual(["wht_1"])
    expect((await getPlainWebhookTarget(connectionId, env))?.webhookToken).toBe(
      pl.createdTargets[1]?.headers[0]?.value,
    )
    pl.workspaceId = "w_other"
    expect((await connect({ connectionId, apiKey: GOOD_KEY })).status).toBe(409)
  })

  it("saves a new target only over the target that the request read", async () => {
    // Two parallel connects: the one that saves second loses, and deletes
    // its own target in Plain.
    const { connectionId } = await connected()
    const save = (previousTargetId: string | null) =>
      savePlainWebhookTarget({
        orgId: seed.orgId,
        connectionId,
        env,
        previousTargetId,
        webhookTargetId: "wht_late",
        webhookToken: "late-token",
      })

    expect(await save(null)).toBe(false)
    expect(await save("wht_other")).toBe(false)
    expect((await getPlainWebhookTarget(connectionId, env))?.webhookToken).toBe(
      pl.createdTargets[0]?.headers[0]?.value,
    )
    expect(await save("wht_1")).toBe(true)
  })

  it("lists the Help Centers and labels for the scope picker", async () => {
    const { connectionId } = await connected()

    const res = await request(`/plain/catalog?connectionId=${connectionId}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      helpCenters: [{ id: "hc_1", name: "Docs" }],
      labels: [{ id: "lt_1", name: "Bug" }],
    })
  })

  it("removes the webhook target, the connection, and its directory row", async () => {
    const { connectionId } = await connected()

    const res = await request(`/plain?connectionId=${connectionId}`, {
      method: "DELETE",
    })

    expect(res.status).toBe(204)
    expect(pl.deletedTargets).toEqual(["wht_1"])
    expect(await storedConfig(connectionId)).toBeUndefined()
    expect(
      await getSystemDb()
        .select()
        .from(connectionDirectory)
        .where(eq(connectionDirectory.connectionId, connectionId)),
    ).toEqual([])
  })

  it("gives an admin of another org 404 for a connection of this org, and changes nothing", async () => {
    const { connectionId } = await connected()
    const deletedBefore = pl.deletedTargets.length

    const asOther = (path: string, init: RequestInit = {}) =>
      request(path, init, otherSeed)
    const query = `connectionId=${connectionId}`
    const responses = await Promise.all([
      asOther(`/plain/status?${query}`),
      asOther(`/plain/catalog?${query}`),
      asOther(`/plain?${query}`, { method: "DELETE" }),
    ])

    expect(responses.map((res) => res.status)).toEqual([404, 404, 404])
    for (const res of responses)
      expect(await res.json()).toEqual({ error: "Unknown Plain connection" })
    // The delete reached neither Plain nor the connection.
    expect(pl.deletedTargets).toHaveLength(deletedBefore)
    expect(await status(connectionId)).toMatchObject({ status: "installed" })
    expect((await request(`/plain/catalog?${query}`)).status).toBe(200)
    // A reconnect of that id, with a valid key, is also unknown to the other org.
    expect(
      (
        await asOther("/plain", {
          method: "POST",
          body: JSON.stringify({ connectionId, apiKey: GOOD_KEY }),
        })
      ).status,
    ).toBe(404)
  })

  it("refuses an org member who is not an admin", async () => {
    await setRole("member")
    try {
      expect((await connect({ apiKey: GOOD_KEY })).status).toBe(403)
    } finally {
      await setRole("owner")
    }
  })
})
