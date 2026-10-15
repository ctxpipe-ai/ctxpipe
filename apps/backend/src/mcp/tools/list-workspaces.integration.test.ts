import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { workspaceCheckoutKey } from "../../domain/workspaces/derived-stores.js"
import { generateObjectId } from "../../lib/id.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import {
  insertLinkedRepositoryRows,
  insertProjectedSourceRows,
} from "../../test/workspace-links-fixture.js"
import { estimateTokens } from "../framework/budget.js"
import { loadServerInstructions } from "../framework/instructions.js"
import { registerMcpReadTools } from "../framework/tool-registry.js"
import { listWorkspaces } from "./list-workspaces.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const CODESEARCH = "http://codesearch.test"

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
      await insertLinkedRepositoryRows(db, [
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
      await insertProjectedSourceRows(db, [
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
          // The links of the Workspace are a GitHub source too (ADR-050).
          { key: "linked-repositories", provider: "github", status: "ok" },
          { key: "tickets", provider: "linear", status: "out_of_access" },
        ],
        units: {},
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
  it("keeps the detail page in budget with a long title and many sources, and cuts no handle", async () => {
    const id = generateObjectId("ws")
    const revision = {
      workspaceId: id,
      generation: 1,
      remote: { url: "https://github.com/example/crowded", connectionId: null },
      defaultBranch: "main",
      sha: "d".repeat(40),
      access: "read" as const,
    }
    const handles = Array.from(
      { length: 60 },
      (_, index) =>
        `example/service-with-a-rather-long-name-${String(index).padStart(2, "0")}`,
    )
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id,
        orgId: seed.orgId,
        slug: "crowded",
        displayName: `Crowded ${"title ".repeat(40)}`,
        workspaceRepositoryUrl: revision.remote.url,
        desiredDefaultBranch: "main",
        activeRevision: revision,
        hydratePhases: {
          url: revision.remote.url,
          sha: revision.sha,
          revision,
          embeddings: true,
          graph: { revision, result: { kind: "ready" } },
          index: { revision, result: { kind: "ready" } },
        },
      })
      await insertLinkedRepositoryRows(
        db,
        handles.map((handle) => ({
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: id,
          gitUrl: `https://github.com/${handle}`,
        })),
      )
      await insertProjectedSourceRows(
        db,
        Array.from({ length: 30 }, (_, index) => ({
          id: generateObjectId("wsrc"),
          orgId: seed.orgId,
          workspaceId: id,
          sourceKey: `source-with-a-long-key-${String(index).padStart(2, "0")}`,
          provider: "github" as const,
          status: "ok" as const,
          revision: revision.sha,
        })),
      )
    })
    const client = await connect()
    try {
      const walked: string[] = []
      let cursor: unknown
      let first = true
      do {
        const result = await call(client, "list_workspaces", {
          org: seed.orgSlug,
          workspace: "crowded",
          ...(cursor ? { cursor } : {}),
        })
        expect(result.isError).not.toBe(true)
        expect(
          estimateTokens(result.content?.[0]?.text ?? ""),
        ).toBeLessThanOrEqual(600)
        if (first) {
          expect((result.structuredContent?.title as string).length).toBe(60)
          // 30 links of the Workspace plus the linked-repositories source.
          expect(result.structuredContent?.sources).toHaveLength(10)
          expect(result.structuredContent?.sourcesNotShown).toBe(21)
          first = false
        }
        walked.push(
          ...((result.structuredContent?.repositories as string[]) ?? []),
        )
        cursor = result.structuredContent?.cursor
      } while (cursor)
      expect(walked.sort()).toEqual([...handles].sort())
    } finally {
      await client.close()
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, id)),
      )
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
      await insertLinkedRepositoryRows(
        db,
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
  it("gives the AGENTS.md description, unit counts per kind, and 50 repositories a page", async () => {
    const id = generateObjectId("ws")
    const repositoryId = generateObjectId("repo")
    const sha = "c".repeat(40)
    const revision = {
      workspaceId: id,
      generation: 1,
      remote: {
        url: "https://github.com/example/handbook",
        connectionId: null,
      },
      defaultBranch: "main",
      sha,
      access: "read" as const,
    }
    const longTitle = `Platform handbook ${"x".repeat(80)}`
    try {
      await withOrgDbContext(seed.orgId, async (db) => {
        await db.insert(workspaces).values({
          id,
          orgId: seed.orgId,
          slug: "a-handbook",
          displayName: longTitle,
          workspaceRepositoryUrl: revision.remote.url,
          desiredDefaultBranch: "main",
          activeRevision: revision,
          hydratePhases: {
            url: revision.remote.url,
            sha,
            revision,
            embeddings: true,
            graph: { revision, result: { kind: "ready" } },
            index: { revision, result: { kind: "ready" } },
          },
        })
        await db.insert(repositories).values({
          id: repositoryId,
          orgId: seed.orgId,
          name: "example/handbook",
          gitUrl: `${revision.remote.url}.git`,
        })
        await db.insert(repositoryCheckouts).values({
          id: generateObjectId("checkout"),
          orgId: seed.orgId,
          repositoryId,
          checkoutKey: workspaceCheckoutKey(id, sha),
          ref: "main",
          commitSha: sha,
        })
        await db.insert(workspaceKnowledgeUnits).values(
          [
            ["knowledge/services/api.md", "Service"],
            ["knowledge/services/web.md", "Service"],
            ["knowledge/decisions/adr-1.md", "Decision"],
            ["notes/loose.md", null],
          ].map(([path, kind]) => ({
            servingId: generateObjectId("kn"),
            orgId: seed.orgId,
            workspaceId: id,
            path: path as string,
            kind,
            body: "Body.",
            projectionSha: sha,
          })),
        )
        await insertLinkedRepositoryRows(
          db,
          Array.from({ length: 60 }, (_, index) => ({
            id: generateObjectId("wlr"),
            orgId: seed.orgId,
            workspaceId: id,
            gitUrl: `https://github.com/example/service-${String(index).padStart(2, "0")}`,
          })),
        )
      })
      vi.stubEnv("CODESEARCH_URL", CODESEARCH)
      const reads: string[] = []
      server.use(
        http.post(
          `${CODESEARCH}/:repoId/files-query`,
          async ({ request, params }) => {
            reads.push(String(params.repoId))
            const body = (await request.json()) as { paths: string[] }
            const agents = [
              "# Platform handbook",
              "",
              "<!-- folder list -->",
              "",
              `Shared   infrastructure for the platform teams. ${"More text. ".repeat(40)}`,
              "",
              "## Folders",
            ].join("\n")
            return HttpResponse.json(
              body.paths.includes("AGENTS.md")
                ? { "AGENTS.md": Buffer.from(agents).toString("base64") }
                : {},
            )
          },
        ),
      )
      const client = await connect()
      try {
        const list = await call(client, "list_workspaces", {})
        const [listed] = list.structuredContent?.orgs as Array<{
          workspaces: Array<{ title: string }>
        }>
        expect(listed?.workspaces[0]?.title).toHaveLength(60)
        expect(listed?.workspaces[0]?.title).toMatch(/^Platform handbook x+/)

        const first = await call(client, "list_workspaces", {
          org: seed.orgSlug,
          workspace: "a-handbook",
        })
        expect(first.isError).not.toBe(true)
        expect(reads).toEqual([repositoryId])
        const description = first.structuredContent?.description as string
        expect(description).toMatch(
          /^Shared infrastructure for the platform teams\. More text\./,
        )
        expect(description.length).toBeLessThanOrEqual(300)
        expect(first.structuredContent?.units).toEqual({
          Decision: 1,
          Service: 2,
          unit: 1,
        })
        const page1 = first.structuredContent?.repositories as string[]
        expect(page1).toHaveLength(50)
        expect(page1[0]).toBe("example/service-00")
        expect(
          estimateTokens(first.content?.[0]?.text ?? ""),
        ).toBeLessThanOrEqual(600)
        const cursor = first.structuredContent?.cursor
        expect(cursor).toEqual(expect.any(String))

        const second = await call(client, "list_workspaces", {
          org: seed.orgSlug,
          workspace: "a-handbook",
          cursor,
        })
        expect(second.isError).not.toBe(true)
        expect(second.structuredContent).toEqual({
          org: seed.orgSlug,
          workspace: "a-handbook",
          repositories: Array.from(
            { length: 10 },
            (_, index) => `example/service-${50 + index}`,
          ),
        })
      } finally {
        await client.close()
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
