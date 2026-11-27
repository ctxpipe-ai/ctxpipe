import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
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
import { knowledgeBranchHeads } from "../../db/schema/knowledge_state.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../../domain/workspaces/hydrate.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import {
  writePlaneDocuments,
  servePlaneHead,
} from "../../test/knowledge-plane.js"
import {
  embeddingModelServer,
  embedText,
  seedKnowledgeWorkspace,
  seedServedWorkspace,
} from "../../test/knowledge-search-fixture.js"
import { searchKnowledgeTool } from "./search-knowledge.js"

/*
 * `search_knowledge` through the MCP client on the knowledge plane: real
 * Postgres and ClickHouse, msw for the embedding model and for Jev. Jev does
 * not answer, so each page has the hits in the search order of the plane.
 */

const modelServer = embeddingModelServer()
modelServer.use(
  http.post("https://search-model.test/alpha/decisions", () =>
    HttpResponse.json({ error: "down" }, { status: 503 }),
  ),
)
const sha = "a".repeat(40)
let seed: SeededOrg
let client: Client
let workspaceId: string
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
/** The admin URL of the knowledge database, for test writes. */
let knowledgeUrl: string

type PlaneUnit = {
  path: string
  title: string
  kind?: string
  updatedAt: string
  body: string
  claims?: Array<{ to: string; predicate: string }>
  validTo?: string
}

/** Write `units` to the knowledge plane as documents of one Workspace. */
async function seedPlaneUnits(id: string, units: PlaneUnit[]) {
  const key = (path: string) => servingIdForKnowledgePath(id, path)
  const writer = createKnowledgeStore(knowledgeUrl)
  try {
    await writePlaneDocuments(
      writer,
      { orgId: seed.orgId, workspaceId: id },
      units.map((unit) => {
        const observedAt = new Date(unit.updatedAt)
        const text = `${unit.title}\n\n${unit.body}`
        return {
          document: {
            docKey: key(unit.path),
            kind: unit.kind ?? "",
            title: unit.title,
            path: unit.path,
            sourceType: "docs",
            source: "",
            summary: unit.title,
            mime: "",
            validFrom: null,
            validTo: unit.validTo ? new Date(unit.validTo) : null,
            observedAt,
          },
          chunks: [
            {
              ordinal: 0,
              text,
              startLine: 1,
              endLine: unit.body.split("\n").length,
              embedding: embedText(text),
            },
          ],
          relations: (unit.claims ?? []).map((claim) => ({
            srcChunk: 0,
            predicate: claim.predicate,
            dstDoc: key(claim.to),
            confidence: 1,
            validFrom: null,
            validTo: null,
            source: "",
            altText: "",
            observedAt,
          })),
        }
      }),
    )
  } finally {
    await writer.close()
  }
}

/** Mark a Workspace ready on the plane: a run applied `tip` in full. */
async function markReady(id: string, tip = sha) {
  await servePlaneHead({ orgId: seed.orgId, workspaceId: id, tip })
}

/** A Workspace of `slug` that the plane serves, with `units`. */
async function seedPlaneWorkspace(slug: string, units: PlaneUnit[]) {
  const { workspaceId: id } = await seedServedWorkspace({ seed, slug, sha })
  await seedPlaneUnits(id, units)
  await markReady(id)
  return id
}

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
    clickHouse = await startClickHouse()
    knowledgeUrl = await clickHouse.freshDatabase()
    await migrateKnowledgeStore(knowledgeUrl, {
      reader: "reader-test",
      writer: "writer-test",
    })
    // The backend reads as the reader user, with SELECT only.
    vi.stubEnv(
      "CLICKHOUSE_URL",
      userUrl(knowledgeUrl, "ctxpipe_reader", "reader-test"),
    )
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
  }, 240_000)
  beforeEach(async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
    )
    workspaceId = await seedPlaneWorkspace("handbook", [
      {
        path: "runbooks/gateway.md",
        title: "Gateway handbook",
        kind: "Runbook",
        updatedAt: "2026-01-10T00:00:00Z",
        body: "# Gateway handbook\n\nRestart the gateway during downtime.",
      },
    ])
    await seedPlaneWorkspace("decisions", [
      {
        path: "linear/task.md",
        title: "Handbook decision",
        kind: "Decision",
        updatedAt: "2025-01-01T00:00:00Z",
        body: "# Handbook decision\n\nThe handbook describes the old gateway.",
        validTo: "2025-12-31T00:00:00Z",
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
    await clickHouse?.stop()
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
    await seedPlaneUnits(
      workspaceId,
      Array.from({ length: 10 }, (_, index) => ({
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
    // The plane gives a claim when its target is a document of the view.
    await seedPlaneUnits(
      workspaceId,
      Array.from({ length: 7 }, (_, index) => ({
        path: `knowledge/teams/team-${index}.md`,
        title: `Team ${index}`,
        updatedAt: "2026-01-01T00:00:00Z",
        body: `# Team ${index}`,
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
    // Five of the seven claims, in the order of the plane, then the count
    // of the others.
    expect(claimed?.claims).toMatch(
      /^(OWNED_BY knowledge\/teams\/team-[0-6]\.md; ){5}\+2 more$/,
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
    // A new knowledge run of the Workspace serves another SHA.
    await markReady(workspaceId, "b".repeat(40))
    expect(
      (await call({ limit: 1, cursor }))._meta?.["ai.ctxpipe/error"],
    ).toMatchObject({ code: "stale_cursor", retryable: false })
  })
  it("keeps large pages within both budgets and preserves every ref in the cursor walk", async () => {
    await seedPlaneUnits(
      workspaceId,
      Array.from({ length: 20 }, (_, index) => ({
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
  it("skips a Workspace with no projection, and fails only when the call names it", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: null, activeRevision: null })
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

  it("skips a Workspace that the plane does not serve yet, and fails only when the call names it", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .delete(knowledgeBranchHeads)
        .where(eq(knowledgeBranchHeads.workspaceId, workspaceId)),
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
  })

  it("gives no hits and the skipped list when no Workspace is ready", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: null, activeRevision: null })
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
