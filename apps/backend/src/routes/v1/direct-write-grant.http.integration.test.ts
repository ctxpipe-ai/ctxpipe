import { createHash } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  oauthAccessTokens,
  oauthClients,
  sessions,
} from "../../db/schema/auth.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerOpenapiRoutes } from "../openapi.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

/**
 * Each REST route that queues a write which lands on the default branch of
 * the Workspace repository without a pull request. The Workspace and the
 * connection do not exist: a request that passes the write gate gets a 400
 * or 404 from the handler, not a 401 or 403.
 */
const DIRECT_WRITE_ROUTES: ReadonlyArray<{
  method: string
  path: string
  body?: unknown
  /**
   * The org admin gate in front of the route reads a Better Auth session, so
   * it already refuses each OAuth token with its own 403.
   */
  adminSessionOnly?: true
}> = [
  { method: "POST", path: "/workspaces", body: { name: "Gate test" } },
  { method: "PATCH", path: "/workspaces/missing-ws", body: { name: "New" } },
  {
    method: "DELETE",
    path: "/workspaces/missing-ws",
    body: { confirmName: "missing-ws" },
  },
  { method: "POST", path: "/workspaces/missing-ws/retry-prepare" },
  {
    method: "POST",
    path: "/workspaces/missing-ws/files/jobs",
    body: { kind: "file", path: "notes/a.md", content: "a" },
  },
  {
    method: "DELETE",
    path: "/workspaces/missing-ws/linked-repositories/lnk_missing",
  },
  { method: "POST", path: "/workspaces/missing-ws/sources", body: {} },
  { method: "PUT", path: "/workspaces/missing-ws/sources/src-a", body: {} },
  { method: "DELETE", path: "/workspaces/missing-ws/sources/src-a" },
  {
    method: "POST",
    path: "/connectors/con_missing/sync",
    adminSessionOnly: true,
  },
]

/** Read routes that a read-only OAuth token and an API key still reach. */
const READ_ROUTES = [
  "/workspaces",
  "/workspaces/missing-ws",
  "/workspaces/missing-ws/sources",
  "/workspaces/missing-ws/linked-repositories",
]

describe("Direct-write REST routes need a session or the ctxpipe:write scope (Postgres)", () => {
  let seed: SeededOrg | undefined
  const clientIds: string[] = []
  let readToken = ""
  let writeToken = ""
  let legacyToken = ""

  function requireSeed(): SeededOrg {
    if (!seed) throw new Error("seedOrg did not run")
    return seed
  }

  /** An opaque OAuth access token of the seeded user with these scopes. */
  async function opaqueToken(scopes: string[]): Promise<string> {
    const s = requireSeed()
    const db = getSystemDb()
    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, s.userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    const clientId = `write_gate_${generateObjectId("oac")}`
    clientIds.push(clientId)
    const token = `write_gate_token_${clientId}`
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      redirectUris: ["http://127.0.0.1:4567/callback"],
      scopes: ["openid", "offline_access", "ctxpipe:read", "ctxpipe:write"],
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: s.userId,
    })
    await db.insert(oauthAccessTokens).values({
      id: generateObjectId("oat"),
      token: createHash("sha256").update(token).digest("base64url"),
      clientId,
      sessionId: session.id,
      userId: s.userId,
      // A legacy reference: the org id itself names the one granted org.
      referenceId: s.orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      scopes,
    })
    return token
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seed = await seedOrg()
    readToken = await opaqueToken(["openid", "ctxpipe:read"])
    writeToken = await opaqueToken(["openid", "ctxpipe:read", "ctxpipe:write"])
    legacyToken = await opaqueToken(["openid", "offline_access"])
  })

  afterAll(async () => {
    if (!seed) return
    const db = getSystemDb()
    for (const clientId of clientIds) {
      await db
        .delete(oauthAccessTokens)
        .where(eq(oauthAccessTokens.clientId, clientId))
      await db.delete(oauthClients).where(eq(oauthClients.clientId, clientId))
    }
    await cleanupSeededOrg(seed)
  })

  function createApp() {
    const env = parseEnv(process.env as Record<string, string | undefined>)
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
      c.set("oauthScopes", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerV1Routes(app)
    return app
  }

  function send(
    route: { method: string; path: string; body?: unknown },
    credential: Record<string, string>,
  ) {
    const s = requireSeed()
    const headers: Record<string, string> = { ...credential }
    if (route.body !== undefined) headers["content-type"] = "application/json"
    return createApp().request(
      `http://backend.test/${s.orgSlug}/api/v1${route.path}`,
      {
        method: route.method,
        headers,
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      },
    )
  }

  async function expectWriteGrantRefusal(
    response: Response,
    route: { adminSessionOnly?: true },
  ) {
    expect(response.status).toBe(403)
    if (route.adminSessionOnly) return
    expect(await response.json()).toMatchObject({
      code: "write_grant_required",
    })
  }

  for (const route of DIRECT_WRITE_ROUTES) {
    const name = `${route.method} ${route.path}`

    it(`refuses a ctxpipe:read OAuth token on ${name}`, async () => {
      const response = await send(route, {
        authorization: `Bearer ${readToken}`,
      })
      await expectWriteGrantRefusal(response, route)
      if (route.adminSessionOnly) return
      const challenge = response.headers.get("www-authenticate") ?? ""
      expect(challenge).toContain('error="insufficient_scope"')
      expect(challenge).toContain('scope="ctxpipe:read ctxpipe:write"')
    })

    it(`refuses an OAuth token from before the ctxpipe scopes on ${name}`, async () => {
      await expectWriteGrantRefusal(
        await send(route, { authorization: `Bearer ${legacyToken}` }),
        route,
      )
    })

    it(`refuses a personal API key on ${name}`, async () => {
      await expectWriteGrantRefusal(
        await send(route, { "x-api-key": requireSeed().personalApiKey }),
        route,
      )
    })

    it(`lets a cookie session through the gate on ${name}`, async () => {
      const response = await send(route, { cookie: requireSeed().cookie })
      expect([401, 403]).not.toContain(response.status)
    })

    if (route.adminSessionOnly) continue
    it(`lets a ctxpipe:write OAuth token through the gate on ${name}`, async () => {
      const response = await send(route, {
        authorization: `Bearer ${writeToken}`,
      })
      expect([401, 403]).not.toContain(response.status)
    })
  }

  for (const path of READ_ROUTES) {
    it(`still serves GET ${path} to a ctxpipe:read OAuth token and an API key`, async () => {
      for (const credential of [
        { authorization: `Bearer ${readToken}` },
        { "x-api-key": requireSeed().personalApiKey },
      ]) {
        const response = await send({ method: "GET", path }, credential)
        expect([401, 403]).not.toContain(response.status)
      }
    })
  }

  it("states the write grant in the OpenAPI doc of each direct-write route and of no other route", async () => {
    const app = new OpenAPIHono<AppEnv>()
    const v1 = registerV1Routes(app)
    registerOpenapiRoutes(app, v1 as OpenAPIHono<AppEnv>)
    const spec = (await (
      await app.request("http://localhost/.docs/openapi")
    ).json()) as {
      paths: Record<
        string,
        Record<string, { description?: string; responses?: object }>
      >
    }
    const stated = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, operation]) =>
          operation.description?.includes("`ctxpipe:write` scope"),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    )
    const base = "/{orgSlug}/api/v1"
    expect(stated.sort()).toEqual(
      [
        `POST ${base}/workspaces`,
        `PATCH ${base}/workspaces/{workspaceSlug}`,
        `DELETE ${base}/workspaces/{workspaceSlug}`,
        `POST ${base}/workspaces/{workspaceSlug}/retry-prepare`,
        `POST ${base}/workspaces/{workspaceSlug}/files/jobs`,
        `DELETE ${base}/workspaces/{workspaceSlug}/linked-repositories/{linkedId}`,
        `POST ${base}/workspaces/{workspaceSlug}/sources`,
        `PUT ${base}/workspaces/{workspaceSlug}/sources/{sourceKey}`,
        `DELETE ${base}/workspaces/{workspaceSlug}/sources/{sourceKey}`,
        `POST ${base}/connectors/{connectionId}/sync`,
      ].sort(),
    )
    expect(
      spec.paths[`${base}/workspaces/{workspaceSlug}/files/jobs`]?.post
        ?.responses,
    ).toHaveProperty("403")
  })

  it("lists the Workspaces of the org for a ctxpipe:read OAuth token", async () => {
    const response = await send(
      { method: "GET", path: "/workspaces" },
      { authorization: `Bearer ${readToken}` },
    )
    expect(response.status).toBe(200)
  })
})
