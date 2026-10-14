import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import { estimateTokens } from "../framework/budget.js"
import { loadServerInstructions } from "../framework/instructions.js"
import { registerMcpReadTools } from "../framework/tool-registry.js"
import { listWorkspaces } from "./list-workspaces.js"

let seed: SeededOrg
function createApp() {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env as Record<string, string | undefined>))
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
  registerMcpRoutes(app, {
    registerTools: (server: McpServer) =>
      registerMcpReadTools(server, [listWorkspaces]),
    instructions: loadServerInstructions,
  })
  return app
}

/** `credential`: an `x-api-key` value, or the request headers to send. */
async function connect(
  credential: string | Record<string, string> = seed.orgApiKey,
  path = "/mcp",
): Promise<Client> {
  const app = createApp()
  const client = new Client({ name: "framework-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: {
        headers:
          typeof credential === "string"
            ? { "x-api-key": credential }
            : credential,
      },
    }),
  )
  // Real clients list the tools first. Then the SDK Client checks each
  // result against the output schema of the tool.
  await client.listTools()
  return client
}

type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: Array<{ type: string; text?: string }>
  _meta?: Record<string, unknown>
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

describe("list_workspaces through MCP", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(workspaces).values(
        Array.from({ length: 100 }, (_, index) => ({
          id: generateObjectId("ws"),
          orgId: seed.orgId,
          slug: `space-${String(index).padStart(3, "0")}`,
          displayName: `Space ${index}`,
          workspaceRepositoryUrl: `/tmp/list-${seed.orgId}/${index}`,
          desiredDefaultBranch: "main",
        })),
      ),
    )
  })
  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
    )
    await cleanupSeededOrg(seed)
  })
  it("lists 100 Workspaces within 20 tokens each and loads the schema eagerly", async () => {
    const client = await connect()
    try {
      const tools = await client.listTools()
      expect(tools.tools[0]?._meta).toEqual({ "anthropic/alwaysLoad": true })
      const result = await call(client, "list_workspaces", {})
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        orgs: [{ org: seed.orgSlug, workspaces: expect.any(Array) }],
      })
      const orgs = result.structuredContent?.orgs as Array<{
        workspaces: unknown[]
      }>
      expect(orgs[0]?.workspaces).toHaveLength(100)
      expect(orgs[0]?.workspaces[0]).toEqual({
        slug: "space-000",
        title: "Space 0",
        repositories: 0,
        ready: false,
      })
      expect(
        estimateTokens(result.content?.[0]?.text ?? ""),
      ).toBeLessThanOrEqual(2000)
      expect(result.structuredContent?.cursor).toBeUndefined()
    } finally {
      await client.close()
    }
  })
  it("describes the served revision, store readiness, handles, and one-line sources", async () => {
    const id = generateObjectId("ws")
    const revision = {
      workspaceId: id,
      generation: 1,
      remote: { url: "https://github.com/example/context", connectionId: null },
      defaultBranch: "main",
      sha: "a".repeat(40),
      access: "read" as const,
    }
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id,
        orgId: seed.orgId,
        slug: "detail",
        displayName: "Detailed Workspace",
        workspaceRepositoryUrl: revision.remote.url,
        desiredDefaultBranch: "next",
        desiredSha: "b".repeat(40),
        activeRevision: revision,
        hydratePhases: {
          url: revision.remote.url,
          sha: revision.sha,
          revision,
          embeddings: true,
          graph: {
            revision,
            result: {
              kind: "failed",
              message: "repo_private: secret diagnostic",
            },
          },
          index: { revision, result: { kind: "pending" } },
        },
      })
      await db.insert(workspaceLinkedRepositories).values([
        {
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: id,
          gitUrl: "git@github.com:example/api.git",
        },
        {
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: id,
          gitUrl: "https://gitlab.example.com/example/api",
        },
      ])
      await db.insert(workspaceSources).values([
        {
          id: generateObjectId("wsrc"),
          orgId: seed.orgId,
          workspaceId: id,
          sourceKey: "code",
          provider: "github",
          status: "ok",
          scope: { repositories: ["example/api", "example/web"] },
          revision: revision.sha,
        },
        {
          id: generateObjectId("wsrc"),
          orgId: seed.orgId,
          workspaceId: id,
          sourceKey: "tickets",
          provider: "linear",
          status: "out_of_access",
          connectionId: "con_private",
          statusDetail: "private diagnostic",
          revision: revision.sha,
        },
      ])
    })
    const client = await connect()
    try {
      const result = await call(client, "list_workspaces", {
        org: seed.orgSlug,
        workspace: "detail",
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({
        org: seed.orgSlug,
        workspace: "detail",
        title: "Detailed Workspace",
        served: { branch: "main", sha: "a".repeat(40) },
        readiness: {
          knowledge: "ready",
          embeddings: "ready",
          graph: "failed",
          index: "pending",
        },
        repositories: [
          "example/web",
          "github.com/example/api",
          "gitlab.example.com/example/api",
        ],
        sources: [
          { key: "code", provider: "github", status: "ok" },
          { key: "tickets", provider: "linear", status: "out_of_access" },
        ],
        skipped: [],
      })
      expect(JSON.stringify(result)).not.toMatch(
        /repo_private|con_private|private diagnostic|wsrc_|wlr_/,
      )
      expect(
        estimateTokens(result.content?.[0]?.text ?? ""),
      ).toBeLessThanOrEqual(600)
    } finally {
      await client.close()
    }
  })
  it("pages 100 Workspaces at a time with a cursor", async () => {
    const client = await connect()
    try {
      const first = await call(client, "list_workspaces", {})
      expect(first.isError).not.toBe(true)
      const firstOrgs = first.structuredContent?.orgs as Array<{
        workspaces: Array<{ slug: string }>
      }>
      expect(firstOrgs[0]?.workspaces).toHaveLength(100)
      const cursor = first.structuredContent?.cursor
      expect(cursor).toEqual(expect.any(String))
      const second = await call(client, "list_workspaces", { cursor })
      const secondOrgs = second.structuredContent?.orgs as Array<{
        org: string
        workspaces: Array<{ slug: string }>
      }>
      expect(secondOrgs).toMatchObject([
        { org: seed.orgSlug, workspaces: [{ slug: "space-099" }] },
      ])
      expect(second.structuredContent?.cursor).toBeUndefined()
    } finally {
      await client.close()
    }
  })
  it("skips a stored repository URL that does not parse, without failing the call", async () => {
    const id = generateObjectId("ws")
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id,
        orgId: seed.orgId,
        slug: "broken",
        displayName: "Broken links",
        workspaceRepositoryUrl: "https://github.com/example/broken-links",
        desiredDefaultBranch: "main",
      })
      await db.insert(workspaceLinkedRepositories).values(
        ["https://github.com/example/fine", "not a url at all"].map(
          (gitUrl) => ({
            id: generateObjectId("wlr"),
            orgId: seed.orgId,
            workspaceId: id,
            gitUrl,
          }),
        ),
      )
    })
    const client = await connect()
    try {
      const list = await call(client, "list_workspaces", {})
      expect(list.isError).not.toBe(true)
      const [listed] = list.structuredContent?.orgs as Array<{
        workspaces: Array<Record<string, unknown>>
        skipped: unknown[]
      }>
      // Slug order: "broken" is first. The URL that does not parse is not counted.
      expect(listed?.workspaces[0]).toMatchObject({
        slug: "broken",
        repositories: 1,
      })
      expect(listed?.skipped).toEqual([
        { workspace: "broken", reason: "invalid_url" },
      ])
      const detail = await call(client, "list_workspaces", {
        org: seed.orgSlug,
        workspace: "broken",
      })
      expect(detail.isError).not.toBe(true)
      expect(detail.structuredContent).toMatchObject({
        repositories: ["example/fine"],
        skipped: [{ workspace: "broken", reason: "invalid_url" }],
      })
      expect(JSON.stringify(detail)).not.toContain("not a url")
    } finally {
      await client.close()
    }
  })
  it("gives org_not_found for an org outside the connection", async () => {
    const client = await connect()
    try {
      const result = await call(client, "list_workspaces", {
        org: `no-such-org-${seed.orgSlug}`,
      })
      expect(result.isError).toBe(true)
      expect(result._meta?.["ai.ctxpipe/error"]).toMatchObject({
        code: "org_not_found",
      })
    } finally {
      await client.close()
    }
  })
})
