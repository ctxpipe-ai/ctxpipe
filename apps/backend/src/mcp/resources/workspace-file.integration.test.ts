import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  workspaceKnowledgeUnits,
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import { registerWorkspaceFileResource } from "./workspace-file.js"

function workspaceFileUri(org: string, workspace: string, ref: string): string {
  const encoded = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/")
  return `ctxpipe://${org}/${workspace}/${encoded}`
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const CODESEARCH = "http://codesearch.test"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const sha1 = "a".repeat(40)
const repositoryName = `ex${suffix}/payments-api`
const foreignOrg = {
  id: generateObjectId("org"),
  slug: `res-foreign-${suffix}`,
}

let seed: SeededOrg
let repositoryId = ""
let client: Client

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
    registerTools: (mcp: McpServer) => registerWorkspaceFileResource(mcp),
  })
  return app
}

async function connect(): Promise<Client> {
  const app = createApp()
  const next = new Client({ name: "resource-test", version: "1.0.0" })
  await next.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { "x-api-key": seed.orgApiKey } },
    }),
  )
  return next
}

async function failure(uri: string): Promise<{ code: number; data: unknown }> {
  const error = await client.readResource({ uri }).then(
    () => null,
    (caught: { code: number; data: unknown }) => caught,
  )
  if (!error) throw new Error(`Reading ${uri} did not fail`)
  return { code: error.code, data: error.data }
}

describe("ctxpipe:// resource template (Postgres + msw codesearch + MCP SDK Client)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await getSystemDb().insert(organizations).values({
      id: foreignOrg.id,
      name: foreignOrg.slug,
      slug: foreignOrg.slug,
      createdAt: new Date(),
    })
    const workspaceId = generateObjectId("ws")
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: "payments",
        displayName: "Payments",
        workspaceRepositoryUrl: `/tmp/res-${suffix}`,
        desiredDefaultBranch: "main",
        activeProjectionSha: sha1,
      })
      await db.insert(workspaceKnowledgeUnits).values({
        servingId: generateObjectId("wku"),
        orgId: seed.orgId,
        workspaceId,
        path: "knowledge/services/payments-api.md",
        body: "# Payments API\n\nOwns card charges.\n",
        projectionSha: sha1,
      })
      await db.insert(workspaceLinkedRepositories).values({
        id: generateObjectId("wlr"),
        orgId: seed.orgId,
        workspaceId,
        gitUrl: `https://github.com/${repositoryName}`,
      })
      repositoryId = generateObjectId("repo")
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: repositoryName,
        gitUrl: `https://github.com/${repositoryName}.git`,
      })
      await db.insert(repositoryCheckouts).values({
        id: generateObjectId("checkout"),
        orgId: seed.orgId,
        repositoryId,
        checkoutKey: "default",
        ref: "main",
        commitSha: sha1,
      })
    })
    // A Workspace of another org, with a unit that this org must never read.
    await withOrgDbContext(foreignOrg.id, async (db) => {
      const foreignWorkspaceId = generateObjectId("ws")
      await db.insert(workspaces).values({
        id: foreignWorkspaceId,
        orgId: foreignOrg.id,
        slug: "foreign-only",
        displayName: "Foreign",
        workspaceRepositoryUrl: `/tmp/res-${suffix}-foreign`,
        desiredDefaultBranch: "main",
        activeProjectionSha: sha1,
      })
      await db.insert(workspaceKnowledgeUnits).values({
        servingId: generateObjectId("wku"),
        orgId: foreignOrg.id,
        workspaceId: foreignWorkspaceId,
        path: "knowledge/secret.md",
        body: "foreign secret\n",
        projectionSha: sha1,
      })
    })
  })

  beforeEach(async () => {
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
    server.use(
      http.post(`${CODESEARCH}/:repoId/files-query`, async ({ request }) => {
        const body = (await request.json()) as { paths: string[] }
        const files: Record<string, string> = {
          "src/limits.ts": "export const LIMIT = 100\n",
        }
        const result: Record<string, string> = {}
        for (const path of body.paths) {
          const text = files[path]
          if (text !== undefined)
            result[path] = Buffer.from(text).toString("base64")
        }
        return HttpResponse.json(result)
      }),
    )
    client = await connect()
  })

  afterEach(async () => {
    await client.close()
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    if (!seed) return
    for (const org of [seed.orgId, foreignOrg.id]) {
      await withOrgDbContext(org, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.orgId, org))
        await db.delete(repositories).where(eq(repositories.orgId, org))
      })
    }
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, foreignOrg.id))
    await cleanupSeededOrg(seed)
  })

  it("lists the template", async () => {
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "ctxpipe://{org}/{workspace}/{+ref}",
    ])
  })

  it("reads a knowledge unit and states the served revision", async () => {
    const uri = workspaceFileUri(
      seed.orgSlug,
      "payments",
      "knowledge/services/payments-api.md",
    )
    const result = await client.readResource({ uri })
    expect(result.contents).toEqual([
      {
        uri,
        mimeType: "text/markdown",
        text: "# Payments API\n\nOwns card charges.",
        _meta: {
          served: { branch: "main", sha: sha1 },
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          nextStartLine: null,
          truncated: false,
        },
      },
    ])
  })

  it("reads a file of a repository that the Workspace links", async () => {
    const uri = workspaceFileUri(
      seed.orgSlug,
      "payments",
      `${repositoryName}:src/limits.ts`,
    )
    const result = await client.readResource({ uri })
    expect(result.contents[0]).toMatchObject({
      mimeType: "text/plain",
      text: "export const LIMIT = 100",
    })
  })

  it("does not read an org that the connection does not grant", async () => {
    const error = await failure(
      workspaceFileUri(foreignOrg.slug, "foreign-only", "knowledge/secret.md"),
    )
    expect(error).toMatchObject({
      code: -32002,
      data: { code: "org_not_found" },
    })
  })

  it("does not read a Workspace of another org through the granted org", async () => {
    const error = await failure(
      workspaceFileUri(seed.orgSlug, "foreign-only", "knowledge/secret.md"),
    )
    expect(error).toMatchObject({
      code: -32002,
      data: { code: "workspace_not_found" },
    })
  })

  it("fails with unknown_ref for a unit that does not exist", async () => {
    const error = await failure(
      workspaceFileUri(seed.orgSlug, "payments", "knowledge/missing.md"),
    )
    expect(error).toMatchObject({
      code: -32002,
      data: { code: "unknown_ref" },
    })
  })

  it("fails with invalid_ref for an empty path segment", async () => {
    const error = await failure(
      `ctxpipe://${seed.orgSlug}/payments/knowledge//api.md`,
    )
    expect(error).toMatchObject({
      code: -32602,
      data: { code: "invalid_ref", retryable: false },
    })
  })
})
