import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

const server = setupServer(
  http.post("https://api.notion.com/v1/oauth/token", () =>
    HttpResponse.json({
      access_token: "notion-access-token",
      refresh_token: "notion-refresh-token",
      bot_id: "bot-1",
      workspace_id: "notion-workspace-1",
      workspace_name: "Acme Docs",
      workspace_icon: null,
    }),
  ),
)

describe("Notion OAuth connect (Postgres + msw)", () => {
  let seed: SeededOrg
  // Hosted shape: the deployment owns the Notion OAuth app.
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    NOTION_CLIENT_ID: "notion-client-id",
    NOTION_CLIENT_SECRET: "notion-client-secret",
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

  const call = (method: "GET" | "POST", path: string) =>
    createApp().request(`http://backend.test${path}`, {
      method,
      headers: { cookie: seed.cookie },
    })

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedOrg()
  })

  afterAll(async () => {
    server.close()
    if (seed) await cleanupSeededOrg(seed)
  })

  it("installs the draft connection from the OAuth callback", async () => {
    const draft = await call(
      "POST",
      `/${seed.orgSlug}/api/v1/connectors/notion/draft`,
    )
    expect(draft.status).toBe(200)
    const { id: connectionId } = (await draft.json()) as { id: string }

    const start = await call(
      "GET",
      `/${seed.orgSlug}/api/v1/connectors/notion/oauth/start?connectionId=${connectionId}`,
    )
    expect(start.status).toBe(200)
    const { authorizationUrl } = (await start.json()) as {
      authorizationUrl: string
    }
    const state = new URL(authorizationUrl).searchParams.get("state")
    expect(state).toBeTruthy()

    const callback = await call(
      "GET",
      `/api/v1/connectors/notion/oauth/callback?${new URLSearchParams({
        code: "notion-code",
        state: state as string,
      })}`,
    )
    expect(callback.status).toBe(200)

    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ config: connections.config })
        .from(connections)
        .where(
          and(
            eq(connections.id, connectionId),
            eq(connections.orgId, seed.orgId),
          ),
        ),
    )
    expect(row?.config).toMatchObject({
      status: "installed",
      workspaceName: "Acme Docs",
    })
  })
})
