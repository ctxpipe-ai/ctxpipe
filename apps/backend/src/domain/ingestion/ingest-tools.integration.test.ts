import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
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
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { ingestSandbox } from "../workspaces/ingest-sandbox.js"
import { destroySandboxesForWorkspace } from "../workspaces/workspace-sandbox-cleanup.js"
import {
  INGEST_TOOL_BRIDGE_PATH,
  ingestToolBridgeRoutes,
  mintIngestToolToken,
} from "./ingest-tools.js"

const CODESEARCH = "http://codesearch.ingest-tools.test"
const AUTH_SECRET = "ingest-tools-test-secret-0123456789abcdef"
const SOURCE_SHA = "a".repeat(40)
const CONTEXT_SHA = "b".repeat(40)
const OTHER_SHA = "c".repeat(40)

type Seen = { path: string; claims: Record<string, unknown>; body: unknown }
const seen: Seen[] = []

function jwtClaims(header: string | null): Record<string, unknown> {
  const payload = header?.replace(/^Bearer /, "").split(".")[1] ?? ""
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

const server = setupServer(
  http.post(`${CODESEARCH}/:repositoryId/files-query`, async ({ request }) => {
    const body = (await request.json()) as { paths: string[] }
    seen.push({
      path: new URL(request.url).pathname,
      claims: jwtClaims(request.headers.get("authorization")),
      body,
    })
    return HttpResponse.json({
      [body.paths[0] ?? ""]: Buffer.from("export const billing = 1\n").toString(
        "base64",
      ),
    })
  }),
  http.post(`${CODESEARCH}/search`, async ({ request }) => {
    seen.push({
      path: new URL(request.url).pathname,
      claims: jwtClaims(request.headers.get("authorization")),
      body: await request.json(),
    })
    return HttpResponse.json({
      Result: {
        Files: [
          {
            FileName: "systems/billing.md",
            Repository: "context",
            LineMatches: [
              {
                LineNumber: 1,
                Line: Buffer.from("# Billing").toString("base64"),
              },
            ],
          },
        ],
      },
    })
  }),
)

const app = new Hono().route("/", ingestToolBridgeRoutes)

async function rpc(token: string | undefined, message: unknown) {
  return app.request(INGEST_TOOL_BRIDGE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  })
}

async function callTool(token: string, name: string, args: unknown) {
  const response = await rpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean }
  }
  return {
    text: body.result.content.map((item) => item.text).join("\n"),
    isError: body.result.isError === true,
  }
}

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tools")
  initDb(url)
  server.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET)
  seen.length = 0
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  server.close()
  const { closeOpenWorkflowClient } = await import(
    "../../openworkflow/client.js"
  )
  await closeOpenWorkflowClient()
  await closeDb()
})

/** A real org, Workspace, and unsandboxed ingest shard with a live row. */
async function withShard<T>(
  fn: (input: {
    orgId: string
    workspaceId: string
    runId: string
    sandbox: ReturnType<typeof ingestSandbox>
    token: string
  }) => Promise<T>,
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const runId = generateObjectId("run")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest tools proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    }),
  )
  const sandbox = ingestSandbox({
    orgId,
    workspaceId,
    runId,
    shard: 0,
    isolation: "unsandboxed",
    provider: localProcessSandbox(),
    image: "local",
  })
  try {
    await sandbox.ensure()
    const token = await mintIngestToolToken({
      authSecret: AUTH_SECRET,
      orgId,
      runId,
      shard: 0,
      sandboxKey: sandbox.key,
      source: { repositoryId: "repo_source", sha: SOURCE_SHA },
      destinations: [
        {
          workspaceId,
          repositories: [{ repositoryId: "repo_context", sha: CONTEXT_SHA }],
        },
      ],
    })
    return await fn({ orgId, workspaceId, runId, sandbox, token })
  } finally {
    await withOrgIdContext({ id: orgId, slug: orgId }, () =>
      destroySandboxesForWorkspace(workspaceId),
    )
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, orgId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
}

describe("ingest tool bridge (Postgres, msw codesearch)", () => {
  it("lists the run's checkouts and only read-only code tools", async () => {
    await withShard(async ({ token, workspaceId }) => {
      const listed = await rpc(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })
      expect(listed.status).toBe(200)
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((tool) => tool.name)
      expect(names).toContain("list_checkouts")
      expect(names).toContain("get_file")
      expect(names).toContain("search")
      expect(names).not.toContain("hybrid_search")
      expect(names).not.toContain("list_repositories")

      const checkouts = await callTool(token, "list_checkouts", {})
      expect(checkouts.text).toContain(`rev:${SOURCE_SHA}`)
      expect(checkouts.text).toContain(`ws:${workspaceId}:${CONTEXT_SHA}`)
    })
  })

  it("reads the source checkout with a source revision claim", async () => {
    await withShard(async ({ token }) => {
      const result = await callTool(token, "get_file", {
        repositoryId: "repo_source",
        checkoutKey: `rev:${SOURCE_SHA}`,
        path: "src/billing.ts",
      })
      expect(result.isError).toBe(false)
      expect(result.text).toContain("export const billing = 1")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe("/repo_source/files-query")
      expect(seen[0]?.claims).toMatchObject({
        repositoryRevisions: [{ repositoryId: "repo_source", sha: SOURCE_SHA }],
      })
      expect(seen[0]?.claims).not.toHaveProperty("workspaceId")
    })
  })

  it("searches a destination Workspace checkout with its Workspace revision claim", async () => {
    await withShard(async ({ token, workspaceId }) => {
      const result = await callTool(token, "search", {
        repositoryId: "repo_context",
        checkoutKey: `ws:${workspaceId}:${CONTEXT_SHA}`,
        query: "billing",
      })
      expect(result.isError).toBe(false)
      expect(result.text).toContain("systems/billing.md")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe("/search")
      expect(seen[0]?.claims).toMatchObject({
        workspaceId,
        workspaceRevisions: [
          { repositoryId: "repo_context", sha: CONTEXT_SHA },
        ],
      })
      expect(seen[0]?.claims).not.toHaveProperty("repositoryRevisions")
      expect(seen[0]?.body).not.toHaveProperty("RepoIDs")
    })
  })

  it("refuses a checkout key or repository outside the run, and calls no codesearch", async () => {
    await withShard(async ({ token, workspaceId }) => {
      for (const args of [
        { repositoryId: "repo_source", checkoutKey: `rev:${OTHER_SHA}` },
        {
          repositoryId: "repo_context",
          checkoutKey: `ws:${workspaceId}:${OTHER_SHA}`,
        },
        {
          repositoryId: "repo_context",
          checkoutKey: `ws:ws_other:${CONTEXT_SHA}`,
        },
        { repositoryId: "repo_other", checkoutKey: `rev:${SOURCE_SHA}` },
        { repositoryId: "repo_source", checkoutKey: "default" },
        { repositoryId: "repo_source" },
      ]) {
        const result = await callTool(token, "get_file", {
          ...args,
          path: "README.md",
        })
        expect(result.text).toContain("checkout_not_in_run")
      }
      expect(seen).toHaveLength(0)
    })
  })

  it("answers 401 to a missing, forged, or wrong-secret token", async () => {
    await withShard(async ({ token, orgId, runId, sandbox }) => {
      const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }
      expect((await rpc(undefined, list)).status).toBe(401)
      expect((await rpc(`${token}x`, list)).status).toBe(401)
      const foreign = await mintIngestToolToken({
        authSecret: "another-secret-0123456789abcdef0123456789",
        orgId,
        runId,
        shard: 0,
        sandboxKey: sandbox.key,
        source: { repositoryId: "repo_source", sha: SOURCE_SHA },
        destinations: [],
      })
      expect((await rpc(foreign, list)).status).toBe(401)
    })
  })

  it("refuses to mint a token for a shard that has no sandbox", async () => {
    await withShard(async ({ orgId, workspaceId, runId }) => {
      const unstarted = ingestSandbox({
        orgId,
        workspaceId,
        runId,
        shard: 1,
        isolation: "unsandboxed",
        provider: localProcessSandbox(),
        image: "local",
      })
      await expect(
        mintIngestToolToken({
          authSecret: AUTH_SECRET,
          orgId,
          runId,
          shard: 1,
          sandboxKey: unstarted.key,
          source: { repositoryId: "repo_source", sha: SOURCE_SHA },
          destinations: [],
        }),
      ).rejects.toThrow(/sandbox/i)
    })
  })

  it("answers 401 after destroy-sandbox revokes the run's token", async () => {
    await withShard(async ({ token, sandbox }) => {
      const before = await callTool(token, "get_file", {
        repositoryId: "repo_source",
        checkoutKey: `rev:${SOURCE_SHA}`,
        path: "src/billing.ts",
      })
      expect(before.isError).toBe(false)
      await sandbox.destroy()
      const after = await rpc(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_file",
          arguments: {
            repositoryId: "repo_source",
            checkoutKey: `rev:${SOURCE_SHA}`,
            path: "src/billing.ts",
          },
        },
      })
      expect(after.status).toBe(401)
      expect(seen).toHaveLength(1)
    })
  })
})
