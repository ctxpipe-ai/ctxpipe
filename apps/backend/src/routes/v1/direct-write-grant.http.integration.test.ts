import { createHash } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  members,
  oauthAccessTokens,
  oauthClients,
  sessions,
} from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerOpenapiRoutes } from "../openapi.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

/**
 * Each REST route that causes a write which lands on the default branch of
 * the Workspace repository without a pull request. The Workspace and the
 * connection do not exist: a request that passes the write gate gets
 * `expectedStatus` from the handler.
 */
const DIRECT_WRITE_ROUTES: ReadonlyArray<{
  method: string
  path: string
  body?: unknown
  expectedStatus: number
  /**
   * The org admin check in front of the route reads a Better Auth session, so
   * it refuses each OAuth access token with its own 403 before the write gate.
   */
  orgAdmin?: true
}> = [
  {
    method: "POST",
    path: "/workspaces",
    body: { name: "Gate test" },
    expectedStatus: 400,
  },
  {
    method: "PATCH",
    path: "/workspaces/missing-ws",
    body: { name: "New" },
    expectedStatus: 404,
  },
  {
    method: "DELETE",
    path: "/workspaces/missing-ws",
    body: { confirmName: "missing-ws" },
    expectedStatus: 404,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/retry-prepare",
    expectedStatus: 404,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/check-write-access",
    expectedStatus: 404,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/files/jobs",
    body: { kind: "file", path: "notes/a.md", content: "a" },
    expectedStatus: 400,
  },
  {
    method: "DELETE",
    path: "/workspaces/missing-ws/linked-repositories/lnk_missing",
    expectedStatus: 404,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/sources",
    body: {},
    expectedStatus: 400,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/sources/batch",
    body: {},
    expectedStatus: 400,
  },
  {
    method: "PUT",
    path: "/workspaces/missing-ws/sources",
    body: {},
    expectedStatus: 400,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/sources/rename",
    body: {},
    expectedStatus: 400,
  },
  {
    method: "DELETE",
    path: "/workspaces/missing-ws/sources",
    body: {},
    expectedStatus: 400,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/upgrades/format-3/start",
    expectedStatus: 404,
    orgAdmin: true,
  },
  {
    method: "POST",
    path: "/workspaces/missing-ws/upgrades/check",
    expectedStatus: 404,
    orgAdmin: true,
  },
  {
    method: "POST",
    path: "/connectors/con_missing/sync",
    expectedStatus: 404,
    orgAdmin: true,
  },
  {
    method: "PATCH",
    path: "/connectors/slack/config?connectionId=con_missing",
    body: { repositoryId: "repo_missing" },
    expectedStatus: 404,
    orgAdmin: true as const,
  },
  ...(["linear", "notion", "pagerduty"] as const).flatMap((connector) => [
    {
      method: "PATCH",
      path: `/connectors/${connector}/config?connectionId=con_missing`,
      body: { scopes: [] },
      // Linear finds no connection. Notion and PagerDuty refuse the body first.
      expectedStatus: connector === "linear" ? 404 : 400,
      orgAdmin: true as const,
    },
    {
      method: "POST",
      path: `/connectors/${connector}/retry?connectionId=con_missing`,
      expectedStatus: 404,
      orgAdmin: true as const,
    },
  ]),
]

/** Read routes that a read-only OAuth token and an API key still reach. */
const READ_ROUTES = [
  { path: "/workspaces", expectedStatus: 200 },
  { path: "/workspaces/missing-ws", expectedStatus: 404 },
  { path: "/workspaces/missing-ws/sources", expectedStatus: 404 },
  { path: "/workspaces/missing-ws/linked-repositories", expectedStatus: 404 },
  { path: "/workspaces/missing-ws/upgrades", expectedStatus: 404 },
]

describe("Direct-write REST routes need a session or the ctxpipe:write scope (Postgres)", () => {
  let seed: SeededOrg | undefined
  const clientIds: string[] = []
  let readToken = ""
  let writeToken = ""
  let legacyToken = ""
  let readJwt = ""
  let sessionToken = ""

  function requireSeed(): SeededOrg {
    if (!seed) throw new Error("seedOrg did not run")
    return seed
  }

  async function seededSession(): Promise<{ id: string; token: string }> {
    const [session] = await getSystemDb()
      .select({ id: sessions.id, token: sessions.token })
      .from(sessions)
      .where(eq(sessions.userId, requireSeed().userId))
      .limit(1)
    if (!session) throw new Error("sign-up did not store a session")
    return session
  }

  /** An opaque OAuth access token of the seeded user with these scopes. */
  async function opaqueToken(scopes: string[]): Promise<string> {
    const s = requireSeed()
    const db = getSystemDb()
    const session = await seededSession()
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

  /** A JWT access token from the server's own key with the `ctxpipe:read` scope. */
  async function readScopeJwt(): Promise<string> {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const session = await seededSession()
    const { token } = await getAuth().api.signJWT({
      body: {
        payload: {
          sub: requireSeed().userId,
          sid: session.id,
          aud: env.AUTH_BASE_URL,
          // The issuer that withAuth accepts.
          iss: new URL("/.auth/api/v1/auth", env.AUTH_BASE_URL).toString(),
          scope: "openid ctxpipe:read",
        },
      },
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
    readJwt = await readScopeJwt()
    sessionToken = (await seededSession()).token
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

  async function expectWriteGrantRefusal(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: "write_grant_required",
    })
  }

  async function expectOrgAdminRefusal(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Forbidden" })
  }

  for (const route of DIRECT_WRITE_ROUTES) {
    const name = `${route.method} ${route.path}`

    it(`refuses a personal API key at the write gate on ${name}`, async () => {
      await expectWriteGrantRefusal(
        await send(route, { "x-api-key": requireSeed().personalApiKey }),
      )
    })

    it(`refuses an org API key (MCP-only) before the write gate on ${name}`, async () => {
      const response = await send(route, {
        "x-api-key": requireSeed().orgApiKey,
      })
      expect(response.status).toBe(401)
    })

    it(`lets a cookie session through the gate on ${name}`, async () => {
      const response = await send(route, { cookie: requireSeed().cookie })
      expect(response.status).toBe(route.expectedStatus)
    })

    it(`lets a Better Auth session token sent as Bearer through the gate on ${name}`, async () => {
      const response = await send(route, {
        authorization: `Bearer ${sessionToken}`,
      })
      expect(response.status).toBe(route.expectedStatus)
    })

    if (route.orgAdmin) {
      for (const [label, token] of [
        ["a ctxpipe:read OAuth token", () => readToken],
        ["a ctxpipe:write OAuth token", () => writeToken],
        ["an OAuth token from before the ctxpipe scopes", () => legacyToken],
        ["a ctxpipe:read JWT access token", () => readJwt],
      ] as const) {
        it(`refuses ${label} at the org admin check before the write gate on ${name}`, async () => {
          await expectOrgAdminRefusal(
            await send(route, { authorization: `Bearer ${token()}` }),
          )
        })
      }
      continue
    }

    it(`refuses a ctxpipe:read OAuth token on ${name}`, async () => {
      const response = await send(route, {
        authorization: `Bearer ${readToken}`,
      })
      await expectWriteGrantRefusal(response)
      const challenge = response.headers.get("www-authenticate") ?? ""
      expect(challenge).toContain('error="insufficient_scope"')
      expect(challenge).toContain('scope="ctxpipe:read ctxpipe:write"')
    })

    it(`refuses a ctxpipe:read JWT access token on ${name}`, async () => {
      await expectWriteGrantRefusal(
        await send(route, { authorization: `Bearer ${readJwt}` }),
      )
    })

    it(`refuses an OAuth token from before the ctxpipe scopes on ${name}`, async () => {
      await expectWriteGrantRefusal(
        await send(route, { authorization: `Bearer ${legacyToken}` }),
      )
    })

    it(`lets a ctxpipe:write OAuth token through the gate on ${name}`, async () => {
      const response = await send(route, {
        authorization: `Bearer ${writeToken}`,
      })
      expect(response.status).toBe(route.expectedStatus)
    })
  }

  it("refuses a plain org member at the admin check on POST /workspaces/{slug}/upgrades/{key}/start", async () => {
    const s = requireSeed()
    const db = getSystemDb()
    const ownerOfSeed = and(
      eq(members.organizationId, s.orgId),
      eq(members.userId, s.userId),
    )
    await db.update(members).set({ role: "member" }).where(ownerOfSeed)
    try {
      await expectOrgAdminRefusal(
        await send(
          {
            method: "POST",
            path: "/workspaces/missing-ws/upgrades/format-3/start",
          },
          { cookie: s.cookie },
        ),
      )
    } finally {
      await db.update(members).set({ role: "owner" }).where(ownerOfSeed)
    }
  })

  it("queues one tip check for an admin on POST /workspaces/{slug}/upgrades/check, and none for a second call in the same minute", async () => {
    const s = requireSeed()
    const slug = `check-${generateObjectId("ws").slice(-8).toLowerCase()}`
    await withOrgDbContext(s.orgId, (db) =>
      db.insert(workspaces).values({
        id: generateObjectId("ws"),
        orgId: s.orgId,
        slug,
        displayName: "Check route workspace",
        workspaceRepositoryUrl: `https://git.example.test/acme/${slug}.git`,
        desiredDefaultBranch: "main",
      }),
    )
    const backend = await BackendPostgres.connect(
      process.env.DATABASE_URL as string,
      { namespaceId: openWorkflowNamespaceId(), runMigrations: false },
    )
    const tipChecks = async () =>
      (await backend.listWorkflowRuns({ limit: 100 })).data
        .filter(
          (run) =>
            run.workflowName === "workspace-tip-check" &&
            (run.input as { orgId?: string })?.orgId === s.orgId,
        )
        .map((run) => run.idempotencyKey)
    const check = () =>
      send(
        { method: "POST", path: `/workspaces/${slug}/upgrades/check` },
        { cookie: s.cookie },
      )
    // Pin the date, so that the key does not depend on the wall clock.
    const minute = Math.floor(Date.now() / 60_000)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(minute * 60_000 + 1_000)
      expect(await tipChecks()).toEqual([])
      const first = await check()
      expect(first.status).toBe(202)
      expect(await first.json()).toEqual({ queued: true })
      expect(await tipChecks()).toEqual([
        `tip-check-on-demand:${s.orgId}:${minute}`,
      ])

      vi.setSystemTime(minute * 60_000 + 30_000)
      const second = await check()
      expect(second.status).toBe(202)
      // No worker runs here, so the first check is still pending.
      expect(await second.json()).toEqual({ queued: true })
      expect(await tipChecks()).toEqual([
        `tip-check-on-demand:${s.orgId}:${minute}`,
      ])
    } finally {
      vi.useRealTimers()
      // Another test file's worker must not claim the queued check.
      for (const run of (await backend.listWorkflowRuns({ limit: 100 })).data)
        if (
          run.workflowName === "workspace-tip-check" &&
          run.status === "pending" &&
          (run.input as { orgId?: string })?.orgId === s.orgId
        )
          await backend.cancelWorkflowRun({ workflowRunId: run.id })
      await backend.stop()
    }
  })

  for (const { path, expectedStatus } of READ_ROUTES) {
    it(`still serves GET ${path} to a ctxpipe:read OAuth token and a personal API key`, async () => {
      for (const credential of <Record<string, string>[]>[
        { authorization: `Bearer ${readToken}` },
        { "x-api-key": requireSeed().personalApiKey },
      ]) {
        const response = await send({ method: "GET", path }, credential)
        expect(response.status).toBe(expectedStatus)
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
        Record<
          string,
          {
            description?: string
            responses?: Record<string, { content?: object }>
          }
        >
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
    const adminOnly = [
      `POST ${base}/workspaces/{workspaceSlug}/upgrades/{key}/start`,
      `POST ${base}/workspaces/{workspaceSlug}/upgrades/check`,
      `POST ${base}/connectors/{connectionId}/sync`,
      ...["linear", "notion", "pagerduty"].flatMap((connector) => [
        `PATCH ${base}/connectors/${connector}/config`,
        `POST ${base}/connectors/${connector}/retry`,
      ]),
      `PATCH ${base}/connectors/slack/config`,
    ]
    expect(stated.sort()).toEqual(
      [
        `POST ${base}/workspaces`,
        `PATCH ${base}/workspaces/{workspaceSlug}`,
        `DELETE ${base}/workspaces/{workspaceSlug}`,
        `POST ${base}/workspaces/{workspaceSlug}/retry-prepare`,
        `POST ${base}/workspaces/{workspaceSlug}/check-write-access`,
        `POST ${base}/workspaces/{workspaceSlug}/files/jobs`,
        `DELETE ${base}/workspaces/{workspaceSlug}/linked-repositories/{linkedId}`,
        `POST ${base}/workspaces/{workspaceSlug}/sources`,
        `POST ${base}/workspaces/{workspaceSlug}/sources/batch`,
        `PUT ${base}/workspaces/{workspaceSlug}/sources`,
        `POST ${base}/workspaces/{workspaceSlug}/sources/rename`,
        `DELETE ${base}/workspaces/{workspaceSlug}/sources`,
        ...adminOnly,
      ].sort(),
    )
    for (const entry of stated) {
      const [method, path] = entry.split(" ") as [string, string]
      const operation = spec.paths[path]?.[method.toLowerCase()]
      expect(operation?.responses?.["403"]?.content).toHaveProperty(
        "application/json",
      )
      expect(operation?.description?.includes("org admin or owner")).toBe(
        adminOnly.includes(entry),
      )
    }
  })
})
