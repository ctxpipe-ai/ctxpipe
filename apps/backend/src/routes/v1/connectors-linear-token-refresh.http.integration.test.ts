import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
} from "../../../test/linear-graphql.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import { linearConnectionToShape } from "../../models/connection-rows.js"
import { resetLinearGraphqlForTests } from "../../services/linear/graphql.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

const tokenRequests: string[] = []
const server = setupServer(
  http.post("https://api.linear.app/oauth/token", async ({ request }) => {
    tokenRequests.push(
      new URLSearchParams(await request.text()).get("refresh_token") ?? "",
    )
    return HttpResponse.json({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 86_399,
      token_type: "Bearer",
      scope: "read",
    })
  }),
)

describe("Linear available scopes with an expired access token (Postgres + msw)", () => {
  let seed: SeededOrg
  let connectionId: string
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
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

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedOrg()
    connectionId = `con_linear_refresh_${Date.now().toString(36)}`
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

  it("refreshes the token and returns the scopes", async () => {
    const calls: LinearGraphqlCall[] = []
    resetLinearGraphqlForTests()
    installLinearGraphql(server, calls, (call) =>
      call.name === "DiscoverScopes"
        ? {
            teams: emptyLinearPage([
              { id: "team-eng", key: "ENG", name: "Engineering" },
            ]),
          }
        : {},
    )
    const response = await createApp().request(
      `http://backend.test/${seed.orgSlug}/api/v1/connectors/linear/available-scopes?connectionId=${connectionId}`,
      { headers: { cookie: seed.cookie } },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: { title: string }[] }
    expect(body.items.map((item) => item.title)).toContain("Engineering")
    expect(tokenRequests).toEqual(["stored-refresh"])
    const row = await withOrgDbContext(seed.orgId, async (db) => {
      const [found] = await db
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
      return found
    })
    expect(row).toBeDefined()
    const shape = linearConnectionToShape(row as never, env)
    expect(shape.accessToken).toBe("fresh-access")
    expect(shape.refreshToken).toBe("fresh-refresh")
  })
})
