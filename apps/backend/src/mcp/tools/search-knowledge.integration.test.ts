import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import {
  embeddingModelServer,
  seedKnowledgeUnits,
  seedKnowledgeWorkspace,
} from "../../test/knowledge-search-fixture.js"
import { searchKnowledgeTool } from "./search-knowledge.js"

const modelServer = embeddingModelServer()
const sha = "a".repeat(40)
let seed: SeededOrg
let client: Client
let workspaceId: string

async function call(
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({
    name: "search_knowledge",
    arguments: { org: seed.orgSlug, query: "handbook", ...args },
  })) as CallToolResult
}

describe("search_knowledge through the MCP client", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://search-model.test/v1")
    modelServer.listen({ onUnhandledRequest: "bypass" })
    seed = await seedOrg()
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(withTestRequestLogger)
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", parseEnv(process.env))
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
      registerTools: (server) => searchKnowledgeTool.register(server),
    })
    client = new Client({ name: "knowledge-contract", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (url, init) => app.request(String(url), init),
        requestInit: { headers: { "x-api-key": seed.orgApiKey } },
      }),
    )
    await client.listTools()
  }, 30_000)
  beforeEach(async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
    )
    workspaceId = `ws_search_${Date.now()}`
    await seedKnowledgeWorkspace(seed.orgId, workspaceId, sha)
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ slug: "handbook", desiredDefaultBranch: "main" })
        .where(eq(workspaces.id, workspaceId)),
    )
    await seedKnowledgeUnits(seed.orgId, sha, [
      {
        id: "unit_handbook",
        workspaceId,
        path: "runbooks/gateway.md",
        title: "Gateway handbook",
        kind: "Runbook",
        source: "authored",
        updatedAt: "2026-01-10T00:00:00Z",
        body: "# Gateway handbook\n\nRestart the gateway during downtime.",
      },
    ])
    const otherId = `${workspaceId}_second`
    await seedKnowledgeWorkspace(seed.orgId, otherId, sha)
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ slug: "decisions", desiredDefaultBranch: "main" })
        .where(eq(workspaces.id, otherId)),
    )
    await seedKnowledgeUnits(seed.orgId, sha, [
      {
        id: "unit_ticket",
        workspaceId: otherId,
        path: "linear/task.md",
        title: "Handbook decision",
        kind: "Decision",
        source: "linear",
        updatedAt: "2025-01-01T00:00:00Z",
        body: "# Handbook decision\n\nThe handbook describes the old gateway.",
        claims: [{ validTo: "2025-12-31" }],
      },
    ])
  })
  afterAll(async () => {
    await client?.close()
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await cleanupSeededOrg(seed)
    }
    modelServer.close()
    vi.unstubAllEnvs()
  })
  it("returns the best chunk with a Workspace slug, file ref, and served revision", async () => {
    const result = await call({ workspaces: ["handbook"] })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      hits: [
        {
          workspace: "handbook",
          ref: "runbooks/gateway.md",
          title: "Gateway handbook",
          snippet: expect.stringContaining("Restart the gateway"),
          served: { branch: "main", sha },
        },
      ],
    })
  })
  it("defaults to 8 hits, allows at most 20, and sums up the claims of each hit", async () => {
    await seedKnowledgeUnits(
      seed.orgId,
      sha,
      Array.from({ length: 10 }, (_, index) => ({
        id: `unit_limit_${index}`,
        workspaceId,
        path: `limit/${index}.md`,
        title: `Handbook ${index}`,
        updatedAt: "2026-01-01T00:00:00Z",
        body: `# Handbook ${index}\n\nThe handbook page ${index}.`,
        claims: Array.from({ length: index === 0 ? 7 : 0 }, (_, claim) => ({
          to: `knowledge/teams/team-${claim}.md`,
          predicate: "OWNED_BY",
        })),
      })),
    )
    const result = await call({ pathPrefix: "limit/" })
    const hits = result.structuredContent?.hits as Array<{
      ref: string
      claims?: string
    }>
    expect(hits).toHaveLength(8)
    for (const hit of hits)
      if (hit.ref !== "limit/0.md") expect(hit.claims).toBeUndefined()
    const [claimed] = (await call({ pathPrefix: "limit/0" })).structuredContent
      ?.hits as Array<{ claims?: string }>
    expect(claimed?.claims).toBe(
      "OWNED_BY knowledge/teams/team-0.md; OWNED_BY knowledge/teams/team-1.md; OWNED_BY knowledge/teams/team-2.md; OWNED_BY knowledge/teams/team-3.md; OWNED_BY knowledge/teams/team-4.md; +2 more",
    )
    expect((await call({ limit: 21 })).isError).toBe(true)
  })
  it("applies each filter and limits the call to selected Workspaces", async () => {
    expect((await call()).structuredContent?.hits).toHaveLength(2)
    for (const filter of [
      { workspaces: ["handbook"] },
      { kinds: ["Runbook"] },
      { pathPrefix: "runbooks/" },
      { sources: ["authored"] },
      { updatedAfter: "2026-01-01T00:00:00Z" },
      { validAt: "2026-01-01T00:00:00Z" },
    ]) {
      const result = await call(filter)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent?.hits).toMatchObject([
        { ref: "runbooks/gateway.md" },
      ])
      expect(result.structuredContent?.hits).toHaveLength(1)
    }
    expect(
      (await call({ pathPrefix: "missing/" })).structuredContent?.hits,
    ).toEqual([])
  })

  it("walks cursor pages without duplicates and rejects changed queries and projections", async () => {
    const first = await call({ limit: 1 })
    const cursor = first.structuredContent?.cursor
    expect(cursor).toEqual(expect.any(String))
    expect(first.structuredContent?.hits).toHaveLength(1)
    const second = await call({ limit: 1, cursor })
    expect(second.isError).not.toBe(true)
    const refs = [first, second]
      .flatMap((result) =>
        (result.structuredContent?.hits as Array<{ ref: string }>).map(
          (hit) => hit.ref,
        ),
      )
      .sort()
    expect(refs).toEqual(["linear/task.md", "runbooks/gateway.md"])
    expect(second.structuredContent?.cursor).toBeUndefined()
    expect(
      (await call({ limit: 1, cursor, query: "different" }))._meta?.[
        "ai.ctxpipe/error"
      ],
    ).toMatchObject({ code: "invalid_cursor" })
    expect(
      (await call({ limit: 1, cursor: "broken" }))._meta?.["ai.ctxpipe/error"],
    ).toMatchObject({ code: "invalid_cursor" })
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: "b".repeat(40) })
        .where(eq(workspaces.id, workspaceId)),
    )
    try {
      expect(
        (await call({ limit: 1, cursor }))._meta?.["ai.ctxpipe/error"],
      ).toMatchObject({ code: "stale_cursor", retryable: false })
    } finally {
      await withOrgDbContext(seed.orgId, (db) =>
        db
          .update(workspaces)
          .set({ activeProjectionSha: sha })
          .where(eq(workspaces.id, workspaceId)),
      )
    }
  })
  it("keeps large pages within both budgets and preserves every ref in the cursor walk", async () => {
    await seedKnowledgeUnits(
      seed.orgId,
      sha,
      Array.from({ length: 20 }, (_, index) => ({
        id: `unit_budget_${index}`,
        workspaceId,
        path: `large/${index}.md`,
        title: `Handbook ${index}`,
        updatedAt: "2026-01-01T00:00:00Z",
        body: `# Handbook ${index}\n\n${'Handbook "quoted" line with \\ escapes. '.repeat(50)}`,
      })),
    )
    const found: string[] = []
    let cursor: unknown
    for (let page = 0; page < 20; page++) {
      const result = await call({
        pathPrefix: "large/",
        limit: 20,
        ...(cursor ? { cursor } : {}),
      })
      expect(result.isError).not.toBe(true)
      expect(
        JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        }).length,
      ).toBeLessThanOrEqual(24_000)
      const text = result.content as Array<{ type: string; text: string }>
      expect(Math.ceil((text[0]?.text.length ?? 0) / 4)).toBeLessThanOrEqual(
        4_000,
      )
      const hits = result.structuredContent?.hits as Array<{
        ref: string
        snippet: string
      }>
      expect(hits.length).toBeGreaterThan(0)
      for (const hit of hits)
        expect(hit.snippet.length).toBeLessThanOrEqual(600)
      found.push(...hits.map((hit) => hit.ref))
      cursor = result.structuredContent?.cursor
      if (!cursor) break
    }
    expect(cursor).toBeUndefined()
    expect(found).toHaveLength(20)
    expect(new Set(found).size).toBe(20)
  })
  it("skips a Workspace that is not ready, and fails only when the call names it", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: null })
        .where(eq(workspaces.id, workspaceId)),
    )
    const byDefault = await call()
    expect(byDefault.isError).not.toBe(true)
    expect(byDefault.structuredContent?.hits).toMatchObject([
      { ref: "linear/task.md" },
    ])
    expect(byDefault.structuredContent?.skipped).toEqual([
      { workspace: "handbook", reason: "not_ready" },
    ])
    expect(
      (await call({ workspaces: ["handbook"] }))._meta?.["ai.ctxpipe/error"],
    ).toMatchObject({ code: "workspace_not_ready", retryable: true })
    const ready = await call({ workspaces: ["decisions"] })
    expect(ready.isError).not.toBe(true)
    expect(ready.structuredContent?.skipped).toEqual([])
    expect(ready.structuredContent?.hits).toMatchObject([
      { ref: "linear/task.md" },
    ])
  })

  it("gives no hits and the skipped list when no Workspace is ready", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: null })
        .where(eq(workspaces.orgId, seed.orgId)),
    )
    const result = await call()
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent?.hits).toEqual([])
    expect(result.structuredContent?.skipped).toEqual([
      { workspace: "decisions", reason: "not_ready" },
      { workspace: "handbook", reason: "not_ready" },
    ])
  })

  it("refuses more than eight Workspaces without an explicit selection", async () => {
    for (let index = 0; index < 7; index++) {
      const extraId = `${workspaceId}_extra_${index}`
      await seedKnowledgeWorkspace(seed.orgId, extraId, sha)
      await withOrgDbContext(seed.orgId, (db) =>
        db
          .update(workspaces)
          .set({ slug: `extra-${index}`, desiredDefaultBranch: "main" })
          .where(eq(workspaces.id, extraId)),
      )
    }
    const refused = await call()
    expect(refused._meta?.["ai.ctxpipe/error"]).toMatchObject({
      code: "invalid_argument",
      retryable: false,
    })
    const named = await call({ workspaces: ["handbook", "decisions"] })
    expect(named.isError).not.toBe(true)
  })

  it("does not disclose a foreign Workspace or search an unknown org", async () => {
    const missing = await call({ workspaces: ["foreign"] })
    expect(missing._meta?.["ai.ctxpipe/error"]).toMatchObject({
      code: "workspace_not_found",
    })
    const foreignOrg = `org_foreign_${Date.now()}`
    const foreignId = `${workspaceId}_foreign`
    await seedKnowledgeWorkspace(foreignOrg, foreignId, sha)
    try {
      await withOrgDbContext(foreignOrg, (db) =>
        db
          .update(workspaces)
          .set({ slug: "foreign", desiredDefaultBranch: "main" })
          .where(eq(workspaces.id, foreignId)),
      )
      const denied = await call({ workspaces: ["foreign"] })
      expect(denied._meta?.["ai.ctxpipe/error"]).toEqual(
        missing._meta?.["ai.ctxpipe/error"],
      )
      expect(
        (await call({ org: "unknown-org" }))._meta?.["ai.ctxpipe/error"],
      ).toMatchObject({ code: "org_not_found" })
    } finally {
      await withOrgDbContext(foreignOrg, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, foreignId)),
      )
    }
  })
})
