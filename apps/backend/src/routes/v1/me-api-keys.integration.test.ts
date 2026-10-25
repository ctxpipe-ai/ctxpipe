import { OpenAPIHono } from "@hono/zod-openapi"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { and, eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { PERSONAL_API_KEY_ORGANIZATIONS_HEADER } from "../../auth/personal-api-key-organizations.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, initDb } from "../../db/client.js"
import { apikeys, members, organizations, users } from "../../db/schema/auth.js"
import { oauthGrantOrganizations } from "../../db/schema/oauth_grant_organizations.js"
import { generateObjectId } from "../../lib/id.js"
import { loadServerInstructions } from "../../mcp/framework/instructions.js"
import { registerMcpReadTools } from "../../mcp/framework/tool-registry.js"
import { TOOL_ERROR_META_KEY } from "../../mcp/framework/tool-result.js"
import { listWorkspaces } from "../../mcp/tools/list-workspaces.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { registerAuthRoutes } from "../auth.js"
import { registerMcpRoutes } from "../mcp.js"
import { registerV1Routes } from "./index.js"

// registerV1Routes loads the conversation graph, which builds its model at import time.
vi.hoisted(() => vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key"))

/**
 * User U is a member of org A (own seed) and org B (added row). User V owns
 * org C; U is not a member of C. Keys are made over HTTP through Better Auth,
 * and used over REST and MCP.
 */
describe("personal API key org set (Postgres)", () => {
  // Better Auth checks the Origin of a cookie request against its base URL.
  const BASE = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
  let seedU: SeededOrg | undefined
  let seedV: SeededOrg | undefined
  const orgB = { id: generateObjectId("org"), slug: "" }
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required for this integration test")
    }
    seedU = await seedOrg()
    seedV = await seedOrg()
    orgB.slug = `keys-b-${suffix}`
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgB.id,
        name: `Keys B ${suffix}`,
        slug: orgB.slug,
        createdAt: new Date(),
      })
    await addMemberB()
  })

  afterAll(async () => {
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, orgB.id))
    for (const seed of [seedV, seedU]) {
      if (!seed) continue
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  function u(): SeededOrg {
    if (!seedU) throw new Error("seed U is missing")
    return seedU
  }

  async function addMemberB(): Promise<void> {
    await getSystemDb()
      .insert(members)
      .values({
        id: generateObjectId("member"),
        organizationId: orgB.id,
        userId: u().userId,
        role: "member",
        createdAt: new Date(),
      })
  }

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
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerAuthRoutes(app)
    registerV1Routes(app)
    registerMcpRoutes(app, {
      registerTools: (server: McpServer) =>
        registerMcpReadTools(server, [listWorkspaces]),
      instructions: loadServerInstructions,
    })
    return app
  }

  /** Create a personal key over HTTP as the browser does. */
  function createKey(name: string, organizations?: string) {
    return createApp().request(`${BASE}/.auth/api/v1/auth/api-key/create`, {
      method: "POST",
      headers: {
        cookie: u().cookie,
        origin: BASE,
        "content-type": "application/json",
        ...(organizations === undefined
          ? {}
          : { [PERSONAL_API_KEY_ORGANIZATIONS_HEADER]: organizations }),
      },
      body: JSON.stringify({ name }),
    })
  }

  async function newKey(
    orgIds: string[],
  ): Promise<{ id: string; key: string }> {
    const response = await createKey(`key-${suffix}`, orgIds.join(","))
    expect(response.status).toBe(200)
    return (await response.json()) as { id: string; key: string }
  }

  async function keyOrgIds(keyId: string): Promise<string[]> {
    const rows = await getSystemDb()
      .select({ id: oauthGrantOrganizations.organizationId })
      .from(oauthGrantOrganizations)
      .where(eq(oauthGrantOrganizations.apiKeyId, keyId))
    return rows.map((row) => row.id).sort()
  }

  function rest(key: string, orgSlug: string) {
    return createApp().request(`${BASE}/${orgSlug}/api/v1/workspaces`, {
      headers: { "x-api-key": key },
    })
  }

  async function mcpListWorkspaces(key: string, org: string) {
    const app = createApp()
    const client = new Client({ name: "api-key-test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (url, init) => app.request(String(url), init),
        requestInit: { headers: { "x-api-key": key } },
      }),
    )
    try {
      await client.listTools()
      return (await client.callTool({
        name: "list_workspaces",
        arguments: { org },
      })) as { isError?: boolean; _meta?: Record<string, unknown> }
    } finally {
      await client.close()
    }
  }

  function putOrganizations(
    keyId: string,
    body: unknown,
    headers: Record<string, string> = { cookie: u().cookie },
  ) {
    return createApp().request(
      `${BASE}/api/v1/me/api-keys/${keyId}/organizations`,
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )
  }

  /** A call to a Better Auth endpoint, as a client with no cookie makes it. */
  function authCall(
    method: "GET" | "POST",
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    return createApp().request(`${BASE}/.auth/api/v1/auth${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function keyIdsNamed(name: string): Promise<string[]> {
    const rows = await getSystemDb()
      .select({ id: apikeys.id })
      .from(apikeys)
      .where(and(eq(apikeys.referenceId, u().userId), eq(apikeys.name, name)))
    return rows.map((row) => row.id)
  }

  it("refuses a key that asks for a new key with a larger org set, and keeps no key", async () => {
    const { key } = await newKey([u().orgId])
    const name = `escalate-${suffix}`
    const response = await authCall(
      "POST",
      "/api-key/create",
      {
        "x-api-key": key,
        [PERSONAL_API_KEY_ORGANIZATIONS_HEADER]: `${u().orgId},${orgB.id}`,
      },
      { name },
    )
    expect(response.status).toBe(403)
    expect(await keyIdsNamed(name)).toEqual([])
  })

  it("refuses a key on the other key endpoints, and the key does not change", async () => {
    const { id, key } = await newKey([u().orgId])
    const headers = { "x-api-key": key }
    const calls = [
      await authCall("GET", "/api-key/list", headers),
      await authCall("GET", `/api-key/get?id=${id}`, headers),
      await authCall("POST", "/api-key/update", headers, {
        keyId: id,
        name: `renamed-${suffix}`,
      }),
      await authCall("POST", "/api-key/delete", headers, { keyId: id }),
    ]
    expect(calls.map((call) => call.status)).toEqual([403, 403, 403, 403])
    const [row] = await getSystemDb()
      .select({ name: apikeys.name })
      .from(apikeys)
      .where(eq(apikeys.id, id))
    expect(row?.name).toBe(`key-${suffix}`)
  })

  it("refuses a key on each Better Auth endpoint that changes data or reads past its org set", async () => {
    const { key } = await newKey([u().orgId])
    const headers = { "x-api-key": key }
    const slug = `key-made-${suffix}`
    const endpoints: Array<["GET" | "POST", string, unknown?]> = [
      ["POST", "/update-user", { name: `changed-${suffix}` }],
      ["POST", "/change-email", { newEmail: `changed-${suffix}@example.com` }],
      ["POST", "/change-password", { currentPassword: "x", newPassword: "y" }],
      ["POST", "/delete-user", {}],
      ["POST", "/unlink-account", { providerId: "credential" }],
      ["POST", "/link-social", { provider: "github" }],
      ["POST", "/revoke-sessions", {}],
      ["POST", "/revoke-other-sessions", {}],
      ["POST", "/revoke-session", { token: "x" }],
      ["GET", "/list-sessions"],
      ["GET", "/list-accounts"],
      ["GET", "/token"],
      ["POST", "/get-access-token", { providerId: "github" }],
      ["POST", "/organization/create", { name: slug, slug }],
      [
        "POST",
        "/organization/update",
        { organizationId: u().orgId, data: { name: slug } },
      ],
      ["POST", "/organization/delete", { organizationId: orgB.id }],
      ["POST", "/organization/set-active", { organizationId: orgB.id }],
      ["POST", "/organization/leave", { organizationId: orgB.id }],
      [
        "POST",
        "/organization/invite-member",
        {
          organizationId: u().orgId,
          email: `${slug}@example.com`,
          role: "owner",
        },
      ],
      [
        "POST",
        "/organization/remove-member",
        { organizationId: u().orgId, memberIdOrEmail: "x" },
      ],
      [
        "POST",
        "/organization/update-member-role",
        { organizationId: u().orgId, memberId: "x", role: "owner" },
      ],
      ["POST", "/organization/accept-invitation", { invitationId: "x" }],
      ["POST", "/organization/cancel-invitation", { invitationId: "x" }],
      ["GET", "/organization/list"],
      ["GET", `/organization/get-full-organization?organizationId=${orgB.id}`],
      ["GET", `/organization/list-members?organizationId=${orgB.id}`],
      ["POST", "/oauth2/consent", { accept: true }],
      [
        "POST",
        "/oauth2/create-client",
        { redirect_uris: ["https://example.com/cb"] },
      ],
      ["GET", "/oauth2/get-consents"],
      ["POST", "/oauth2/delete-consent", { id: "x" }],
      ["POST", "/device/approve", { userCode: "x" }],
      ["POST", "/two-factor/enable", { password: "x" }],
      ["GET", "/passkey/generate-register-options"],
      ["POST", "/update-session", {}],
    ]
    const refused: string[] = []
    for (const [method, path, body] of endpoints) {
      const response = await authCall(method, path, headers, body)
      if (response.status !== 403) refused.push(`${path} ${response.status}`)
    }
    expect(refused).toEqual([])
    const [user] = await getSystemDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, u().userId))
    expect(user?.name).not.toBe(`changed-${suffix}`)
    const made = await getSystemDb()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
    expect(made).toEqual([])
    // The key still reads its session and its org over REST.
    expect((await authCall("GET", "/get-session", headers)).status).toBe(200)
    expect((await rest(key, u().orgSlug)).status).toBe(200)
  })

  it("lets a browser session list, update, and delete its keys", async () => {
    const { id } = await newKey([u().orgId])
    const headers = { cookie: u().cookie, origin: BASE }
    const listed = await authCall("GET", "/api-key/list", headers)
    expect(listed.status).toBe(200)
    expect(
      (await authCall("GET", `/api-key/get?id=${id}`, headers)).status,
    ).toBe(200)
    const name = `renamed-${suffix}`
    expect(
      (
        await authCall("POST", "/api-key/update", headers, {
          keyId: id,
          name,
        })
      ).status,
    ).toBe(200)
    expect(await keyIdsNamed(name)).toEqual([id])
    expect(
      (await authCall("POST", "/api-key/delete", headers, { keyId: id }))
        .status,
    ).toBe(200)
    expect(await keyIdsNamed(name)).toEqual([])
  })

  it("writes the set at creation, and the key reaches only that org over REST and MCP", async () => {
    const { id, key } = await newKey([u().orgId])
    expect(await keyOrgIds(id)).toEqual([u().orgId])

    expect((await rest(key, u().orgSlug)).status).toBe(200)
    expect((await rest(key, orgB.slug)).status).toBe(404)

    const outside = await mcpListWorkspaces(key, orgB.slug)
    expect(outside.isError).toBe(true)
    expect(outside._meta?.[TOOL_ERROR_META_KEY]).toMatchObject({
      code: "org_not_found",
    })
    expect((await mcpListWorkspaces(key, u().orgSlug)).isError).toBeFalsy()
  })

  it("refuses to make a key for an org that is not a membership, or with no org, and keeps no key", async () => {
    const name = `refused-${suffix}`
    const foreign = await createKey(name, `${u().orgId},${seedV?.orgId}`)
    expect(foreign.status).toBe(400)
    const none = await createKey(name)
    expect(none.status).toBe(400)
    const empty = await createKey(name, " , ")
    expect(empty.status).toBe(400)
    const left = await getSystemDb()
      .select({ id: apikeys.id })
      .from(apikeys)
      .where(and(eq(apikeys.referenceId, u().userId), eq(apikeys.name, name)))
    expect(left).toEqual([])
  })

  it("changes the set from a browser session only, and refuses an empty set and a foreign org", async () => {
    const { id, key } = await newKey([u().orgId])
    expect((await rest(key, orgB.slug)).status).toBe(404)

    expect(
      (await putOrganizations(id, { organizationIds: [u().orgId, orgB.id] }))
        .status,
    ).toBe(204)
    expect(await keyOrgIds(id)).toEqual([u().orgId, orgB.id].sort())
    expect((await rest(key, orgB.slug)).status).toBe(200)

    expect((await putOrganizations(id, { organizationIds: [] })).status).toBe(
      400,
    )
    expect(
      (await putOrganizations(id, { organizationIds: [seedV?.orgId] })).status,
    ).toBe(400)
    // The key cannot change its own set.
    expect(
      (
        await putOrganizations(
          id,
          { organizationIds: [u().orgId] },
          { "x-api-key": key },
        )
      ).status,
    ).toBe(403)
    // Another user cannot change the set of this key.
    expect(
      (
        await putOrganizations(
          id,
          { organizationIds: [seedV?.orgId] },
          { cookie: seedV?.cookie ?? "" },
        )
      ).status,
    ).toBe(404)
    expect(await keyOrgIds(id)).toEqual([u().orgId, orgB.id].sort())

    const listed = await createApp().request(`${BASE}/api/v1/me/api-keys`, {
      headers: { cookie: u().cookie },
    })
    expect(listed.status).toBe(200)
    const { keys } = (await listed.json()) as {
      keys: Array<{ id: string; organizations: { id: string }[] | null }>
    }
    expect(
      keys.find((item) => item.id === id)?.organizations?.map((org) => org.id),
    ).toEqual(expect.arrayContaining([u().orgId, orgB.id]))
  })

  it("keeps every membership for a key with no set", async () => {
    // The seed makes its key server-side, with no set.
    const [legacy] = await getSystemDb()
      .select({ id: apikeys.id })
      .from(apikeys)
      .where(
        and(
          eq(apikeys.referenceId, u().userId),
          eq(apikeys.name, "integration-personal"),
        ),
      )
    expect(legacy && (await keyOrgIds(legacy.id))).toEqual([])
    expect((await rest(u().personalApiKey, u().orgSlug)).status).toBe(200)
    expect((await rest(u().personalApiKey, orgB.slug)).status).toBe(200)
    expect((await rest(u().personalApiKey, seedV?.orgSlug ?? "")).status).toBe(
      404,
    )
  })

  it("denies the next call after the membership is removed", async () => {
    const { key } = await newKey([u().orgId, orgB.id])
    expect((await rest(key, orgB.slug)).status).toBe(200)
    await getSystemDb()
      .delete(members)
      .where(
        and(
          eq(members.organizationId, orgB.id),
          eq(members.userId, u().userId),
        ),
      )
    try {
      expect((await rest(key, orgB.slug)).status).toBe(404)
    } finally {
      await addMemberB()
    }
  })
})
