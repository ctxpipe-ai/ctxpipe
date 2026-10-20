import { createHmac, randomUUID } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { generateObjectId } from "../../lib/id.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { registerV1Routes } from "../../routes/v1/index.js"
import { ingestSandboxThreadId } from "../workspaces/chat-lifecycle.js"
import {
  mintWorkspaceIngestRunCapability,
  mintWorkspaceIngestToolsCapability,
} from "../workspaces/workspace-chat-run-capability.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  type IngestionV2RunInput,
} from "./ingestion-run.js"

const spans = recordSpans()

const CODESEARCH = "http://codesearch.ingest-tools.test"
const AUTH_SECRET = "ingest-tools-test-secret-0123456789abcdef"
const BRIDGE = "/api/v1/workspace-ingest/tool-bridge"
const SOURCE_SHA = "a".repeat(40)
const CONTEXT_SHA = "b".repeat(40)
const OTHER_SHA = "c".repeat(40)

type Seen = { path: string; claims: Record<string, unknown>; body: unknown }
const seen: Seen[] = []

function jwtClaims(header: string | null): Record<string, unknown> {
  const payload = header?.replace(/^Bearer /, "").split(".")[1] ?? ""
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

async function record(request: Request): Promise<unknown> {
  const body = await request.json()
  seen.push({
    path: new URL(request.url).pathname,
    claims: jwtClaims(request.headers.get("authorization")),
    body,
  })
  return body
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.post(`${CODESEARCH}/:repositoryId/files-query`, async ({ request }) => {
    const body = (await record(request)) as { paths: string[] }
    return HttpResponse.json({
      [body.paths[0] ?? ""]: Buffer.from("export const billing = 1\n").toString(
        "base64",
      ),
    })
  }),
  http.post(`${CODESEARCH}/search`, async ({ request }) => {
    await record(request)
    return HttpResponse.json({
      Result: {
        Files: [
          {
            FileName: "src/billing.ts",
            LineMatches: [
              {
                LineNumber: 1,
                Line: Buffer.from("export const billing").toString("base64"),
              },
            ],
          },
        ],
      },
    })
  }),
  http.post(
    `${CODESEARCH}/:repositoryId/structural-search`,
    async ({ request }) => {
      await record(request)
      return HttpResponse.json({ matches: [{ file: "src/billing.ts" }] })
    },
  ),
  http.post(`${CODESEARCH}/:repositoryId/graph`, async ({ request }) => {
    await record(request)
    return HttpResponse.json({ nodes: [{ symbol: "billing" }] })
  }),
)

const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/ctxpipe_test",
  GRAPH_DB_URI: "redis://localhost:6379",
  AUTH_BASE_URL: "https://backend.example.com",
  AUTH_SECRET,
  PORT: "3000",
})

function app(): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>()
  routes.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  registerV1Routes(routes)
  return routes
}

async function rpc(token: string | undefined, message: unknown) {
  return app().request(BRIDGE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  })
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" }

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

function signed(claims: object, purpose: string): string {
  const key = createHmac("sha256", AUTH_SECRET)
    .update(`ctxpipe:capability:${purpose}`)
    .digest()
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
  )
}

type Org = { orgId: string; orgSlug: string; source: string; context: string }
const orgs: Org[] = []
let backend: BackendPostgres

async function createOrg(): Promise<Org> {
  const orgId = generateObjectId("org")
  const org = {
    orgId,
    orgSlug: `ingest-tools-${orgId.slice(-8)}`,
    source: generateObjectId("repo"),
    context: generateObjectId("repo"),
  }
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: org.orgSlug,
    name: "Ingest tools proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(repositories).values([
      {
        id: org.source,
        orgId,
        name: "source",
        gitUrl: "https://example.test/source.git",
      },
      {
        id: org.context,
        orgId,
        name: "context",
        gitUrl: "https://example.test/context.git",
      },
    ]),
  )
  orgs.push(org)
  return org
}

async function startRun(orgId: string): Promise<string> {
  const run = await backend.createWorkflowRun({
    workflowName: INGESTION_V2_WORKFLOW_NAME,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: { orgId, shadow: true } satisfies IngestionV2RunInput,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    // Never due: no worker claims it.
    availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
    deadlineAt: null,
  })
  return run.id
}

async function holdShard(orgId: string, runId: string, shard: number) {
  const owner = randomUUID()
  await withOrgDbContext(orgId, (db) =>
    db
      .insert(sandboxLocks)
      .values({
        orgId,
        key: ingestSandboxThreadId(runId, shard),
        owner,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoUpdate({
        target: [sandboxLocks.orgId, sandboxLocks.key],
        set: { owner },
      }),
  )
  return owner
}

const workspaceId = generateObjectId("ws")

function checkoutsOf(org: Pick<Org, "source" | "context">) {
  return [
    {
      repositoryId: org.source,
      checkoutKey: `rev:${SOURCE_SHA}`,
      sha: SOURCE_SHA,
    },
    {
      repositoryId: org.context,
      checkoutKey: `ws:${workspaceId}:${CONTEXT_SHA}`,
      sha: CONTEXT_SHA,
    },
  ]
}

/** A step of a live run that holds shard 0, and its tools capability. */
async function step(org: Org, checkouts = checkoutsOf(org)) {
  const runId = await startRun(org.orgId)
  const lockOwner = await holdShard(org.orgId, runId, 0)
  const input = {
    authSecret: AUTH_SECRET,
    orgId: org.orgId,
    orgSlug: org.orgSlug,
    runId,
    shard: 0,
    step: "skill:root:apis",
    lockOwner,
  }
  return {
    runId,
    lockOwner,
    input,
    token: await mintWorkspaceIngestToolsCapability({ ...input, checkouts }),
  }
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tools")
  initDb(url)
  backend = await BackendPostgres.connect(url, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
})

beforeEach(() => {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET)
  seen.length = 0
  return () => vi.unstubAllEnvs()
})

afterAll(async () => {
  for (const org of orgs) {
    await withOrgDbContext(org.orgId, async (db) => {
      await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, org.orgId))
      await db.delete(repositories).where(eq(repositories.orgId, org.orgId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.orgId))
  }
  await backend.stop()
  const { closeOpenWorkflowClient } = await import(
    "../../openworkflow/client.js"
  )
  await closeOpenWorkflowClient()
  await closeDb()
})

describe("ingest tool bridge through registerV1Routes (Postgres, msw codesearch)", () => {
  it("lists the capability's checkouts and only read-only code tools", async () => {
    const org = await createOrg()
    const { token } = await step(org)
    const listed = await rpc(token, LIST)
    expect(listed.status).toBe(200)
    const names = (
      (await listed.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "list_checkouts",
        "get_file",
        "search",
        "structural_search",
        "graph_find_symbol",
      ]),
    )
    expect(names).not.toContain("hybrid_search")
    expect(names).not.toContain("list_repositories")
    const checkouts = await callTool(token, "list_checkouts", {})
    expect(checkouts.text).toContain(`rev:${SOURCE_SHA}`)
    expect(checkouts.text).toContain(`ws:${workspaceId}:${CONTEXT_SHA}`)
  })

  it("runs get_file, search, structural_search, and a graph tool on the source checkout with its revision claim", async () => {
    const org = await createOrg()
    const { token } = await step(org)
    const at = { repositoryId: org.source, checkoutKey: `rev:${SOURCE_SHA}` }
    const file = await callTool(token, "get_file", { ...at, path: "a.ts" })
    expect(file.text).toContain("export const billing = 1")
    const search = await callTool(token, "search", { ...at, query: "billing" })
    expect(search.text).toContain("src/billing.ts")
    const structural = await callTool(token, "structural_search", {
      ...at,
      pattern: "export const $A = $B",
    })
    expect(structural.text).toContain("src/billing.ts")
    const graph = await callTool(token, "graph_find_symbol", {
      ...at,
      symbol: "billing",
    })
    expect(graph.text).toContain("billing")
    for (const result of [file, search, structural, graph])
      expect(result.isError).toBe(false)
    expect(seen.map((item) => item.path)).toEqual([
      `/${org.source}/files-query`,
      "/search",
      `/${org.source}/structural-search`,
      `/${org.source}/graph`,
    ])
    for (const item of seen) {
      expect(item.claims).toMatchObject({
        orgId: org.orgId,
        repositoryRevisions: [{ repositoryId: org.source, sha: SOURCE_SHA }],
      })
      expect(item.claims).not.toHaveProperty("workspaceId")
    }
    expect(seen[1]?.body).not.toHaveProperty("RepoIDs")
  })

  it("searches a destination Workspace checkout with its Workspace revision claim", async () => {
    const org = await createOrg()
    const { token } = await step(org)
    const result = await callTool(token, "search", {
      repositoryId: org.context,
      checkoutKey: `ws:${workspaceId}:${CONTEXT_SHA}`,
      query: "billing",
    })
    expect(result.isError).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.claims).toMatchObject({
      workspaceId,
      workspaceRevisions: [{ repositoryId: org.context, sha: CONTEXT_SHA }],
    })
    expect(seen[0]?.claims).not.toHaveProperty("repositoryRevisions")
    expect(seen[0]?.body).not.toHaveProperty("RepoIDs")
  })

  it("refuses a checkout key or repository outside the capability, and calls no codesearch", async () => {
    const org = await createOrg()
    const { token } = await step(org)
    for (const args of [
      { repositoryId: org.source, checkoutKey: `rev:${OTHER_SHA}` },
      {
        repositoryId: org.context,
        checkoutKey: `ws:${workspaceId}:${OTHER_SHA}`,
      },
      { repositoryId: org.context, checkoutKey: `ws:ws_other:${CONTEXT_SHA}` },
      { repositoryId: org.context, checkoutKey: `rev:${SOURCE_SHA}` },
      { repositoryId: "repo_other", checkoutKey: `rev:${SOURCE_SHA}` },
      { repositoryId: org.source },
    ]) {
      const result = await callTool(token, "get_file", {
        ...args,
        path: "README.md",
      })
      expect(result.text).toContain("checkout_not_in_run")
    }
    expect(seen).toHaveLength(0)
  })

  it("records the call id, the result size, and the error code of each tool call on a span", async () => {
    const org = await createOrg()
    const { token } = await step(org)
    const at = { repositoryId: org.source, checkoutKey: `rev:${SOURCE_SHA}` }

    const file = await callTool(token, "get_file", { ...at, path: "a.ts" })
    const fileSpan = spans.spanNamed("bridge.tool get_file")
    expect(fileSpan?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "get_file",
      "ctxpipe.mcp.call.id": expect.stringMatching(/^call_/),
      "ctxpipe.mcp.result.bytes": Buffer.byteLength(file.text),
    })
    expect(fileSpan?.attributes["ctxpipe.mcp.error.code"]).toBeUndefined()

    spans.reset()
    await callTool(token, "get_file", {
      repositoryId: org.source,
      checkoutKey: `rev:${OTHER_SHA}`,
      path: "a.ts",
    })
    expect(
      spans.spanNamed("bridge.tool get_file")?.attributes[
        "ctxpipe.mcp.error.code"
      ],
    ).toBe("checkout_not_in_run")
  })

  it("answers 401 to a missing token, a changed payload with its old signature, and a model capability", async () => {
    const org = await createOrg()
    const { token, input } = await step(org)
    const [payload, signature] = token.split(".")
    const changed = Buffer.from(
      JSON.stringify({
        ...claimsOf(token),
        checkouts: [
          {
            repositoryId: org.source,
            checkoutKey: `rev:${OTHER_SHA}`,
            sha: OTHER_SHA,
          },
        ],
      }),
    ).toString("base64url")
    expect(payload).not.toBe(changed)
    const model = await mintWorkspaceIngestRunCapability(input)
    for (const presented of [undefined, `${changed}.${signature}`, model])
      expect((await rpc(presented, LIST)).status).toBe(401)
    expect((await rpc(token, LIST)).status).toBe(200)
  })

  it("answers 401 to a well-signed capability of another run, shard, or org", async () => {
    const org = await createOrg()
    const other = await createOrg()
    const { token } = await step(org)
    const claims = claimsOf(token)
    for (const change of [
      { runId: await startRun(org.orgId) },
      { shard: 1 },
      { orgId: other.orgId, orgSlug: other.orgSlug },
    ])
      expect(
        (
          await rpc(
            signed({ ...claims, ...change }, "workspace-ingest-tools"),
            LIST,
          )
        ).status,
      ).toBe(401)
    expect(
      (await rpc(signed(claims, "workspace-ingest-tools"), LIST)).status,
    ).toBe(200)
  })

  it("answers 403 when a claimed repository is not the capability org's", async () => {
    const org = await createOrg()
    const other = await createOrg()
    // A live step of `other` whose capability names `org`'s repositories.
    const { token } = await step(other, checkoutsOf(org))
    expect((await rpc(token, LIST)).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it("answers 405, not 401, to the GET stream that an MCP client opens", async () => {
    // A 401 makes the OpenCode MCP client start OAuth discovery (CTX-918).
    const org = await createOrg()
    const { token } = await step(org)
    for (const authorization of [`Bearer ${token}`, undefined]) {
      const response = await app().request(BRIDGE, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(authorization ? { authorization } : {}),
        },
      })
      expect(response.status).toBe(405)
    }
  })

  it("answers 401 after the step lets the shard lock go, and after the run is cancelled", async () => {
    const org = await createOrg()
    const released = await step(org)
    expect((await rpc(released.token, LIST)).status).toBe(200)
    await withOrgDbContext(org.orgId, (db) =>
      db
        .delete(sandboxLocks)
        .where(eq(sandboxLocks.key, ingestSandboxThreadId(released.runId, 0))),
    )
    expect((await rpc(released.token, LIST)).status).toBe(401)

    const cancelled = await step(org)
    expect((await rpc(cancelled.token, LIST)).status).toBe(200)
    await backend.cancelWorkflowRun({ workflowRunId: cancelled.runId })
    expect((await rpc(cancelled.token, LIST)).status).toBe(401)
  })
})
