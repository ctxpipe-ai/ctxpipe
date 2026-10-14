import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { hasWorkspaceGraph } from "../../domain/workspaces/graph-projection.js"
import { closeGraphDb } from "../../platform/graph/client.js"
import { embeddingModelServer } from "../../test/knowledge-search-fixture.js"
import {
  callTool,
  connectToolClient,
  deleteRevisionGraph,
  dropOrgGraph,
  type RelatedUnit,
  seedRelatedWorkspace,
} from "../../test/related-fixture.js"
import { TOOL_ERROR_META_KEY } from "../framework/tool-result.js"
import {
  getRelatedInputShape,
  getRelatedTool,
  rankWorkspaceRelated,
} from "./get-related.js"

const modelServer = embeddingModelServer()

/** Design example 2: who depends on a library, and who owns them. */
const platformUnits: RelatedUnit[] = [
  { path: "knowledge/libraries/rate-limiter.md", kind: "Library" },
  ...(
    [
      ["payments-api", 0.9],
      ["gateway", 0.7],
      ["search-api", 0.5],
    ] as const
  ).map(([name, confidence]) => ({
    path: `knowledge/services/${name}.md`,
    kind: "Service",
    claims: [
      {
        to: "knowledge/libraries/rate-limiter.md",
        predicate: "DEPENDS_ON",
        confidence,
      },
    ],
  })),
  ...(
    [
      ["payments", "payments-api"],
      ["edge", "gateway"],
      ["discovery", "search-api"],
    ] as const
  ).map(([team, service]) => ({
    path: `knowledge/teams/${team}.md`,
    kind: "Team",
    claims: [
      {
        to: `knowledge/services/${service}.md`,
        predicate: "OWNS",
        confidence: 0.9,
      },
    ],
  })),
  {
    path: "knowledge/docs/overview.md",
    kind: "Doc",
    claims: [
      {
        to: "knowledge/libraries/rate-limiter.md",
        predicate: "MENTIONS",
        confidence: 0.9,
      },
    ],
  },
]

/** Design example 1: incident context, with an incident that ended in July. */
const paymentsUnits: RelatedUnit[] = [
  {
    path: "knowledge/services/checkout-api.md",
    kind: "Service",
    title: "Checkout API",
    body: "# Checkout API\n\nThe checkout service.",
    claims: [
      {
        to: "knowledge/databases/payments-db.md",
        predicate: "DEPENDS_ON",
        confidence: 0.9,
      },
    ],
  },
  {
    path: "pagerduty/incidents/q7.md",
    kind: "Incident",
    title: "Checkout 502 errors after deploy",
    body: "# Checkout 502 errors after deploy\n\nConnection pool exhaustion after the deploy made checkout fail.",
    claims: [
      {
        to: "knowledge/services/checkout-api.md",
        predicate: "AFFECTS",
        confidence: 0.9,
        validFrom: "2026-09-10T00:00:00Z",
      },
      {
        to: "linear/issues/PAY-311.md",
        predicate: "TRACKED_BY",
        confidence: 0.7,
      },
    ],
  },
  {
    path: "pagerduty/incidents/q3.md",
    kind: "Incident",
    title: "Checkout slowdown",
    body: "# Checkout slowdown\n\nA slow query.",
    claims: [
      {
        to: "knowledge/services/checkout-api.md",
        predicate: "AFFECTS",
        confidence: 0.9,
        validFrom: "2026-06-01T00:00:00Z",
        validTo: "2026-07-01T00:00:00Z",
      },
    ],
  },
  {
    path: "knowledge/databases/payments-db.md",
    kind: "Database",
    title: "Payments database",
    body: "# Payments database\n\nThe primary store.",
  },
  {
    path: "knowledge/decisions/adr-012.md",
    kind: "Decision",
    title: "Use the pooler in transaction mode",
    body: "# Use the pooler in transaction mode\n\nPooler settings.",
    claims: [
      {
        to: "knowledge/databases/payments-db.md",
        predicate: "INFLUENCES",
        confidence: 0.8,
      },
    ],
  },
  {
    path: "knowledge/runbooks/db-connection-saturation.md",
    kind: "Runbook",
    title: "DB saturation",
    body: "# DB saturation\n\nWhen the database saturates.",
    claims: [
      {
        to: "knowledge/databases/payments-db.md",
        predicate: "APPLIES_TO",
        confidence: 0.8,
      },
    ],
  },
  {
    path: "linear/issues/PAY-311.md",
    kind: "Issue",
    title: "Raise pool size for checkout workers",
    body: "# Raise pool size\n\nA ticket.",
  },
]

/** One unit with three edges; the edge to `y` ends one hour after the seeding. */
const endingUnits: RelatedUnit[] = [
  {
    path: "knowledge/ending.md",
    kind: "Service",
    claims: [
      ["x", 0.9, undefined],
      ["y", 0.8, new Date(Date.now() + 3_600_000).toISOString()],
      ["z", 0.7, undefined],
    ].map(([target, confidence, validTo]) => ({
      to: `knowledge/${target}.md`,
      predicate: "DEPENDS_ON",
      confidence: confidence as number,
      validFrom: "2026-01-01T00:00:00.000Z",
      ...(validTo ? { validTo: validTo as string } : {}),
    })),
  },
  ...["x", "y", "z"].map((name) => ({
    path: `knowledge/${name}.md`,
    kind: "Library",
  })),
]

const checkout = "knowledge/services/checkout-api.md"
const limiter = "knowledge/libraries/rate-limiter.md"
const sha = (letter: string) => letter.repeat(40)

let seed: SeededOrg
let client: Client
let queueRevision: Awaited<ReturnType<typeof seedRelatedWorkspace>>["revision"]

const related = (args: Record<string, unknown>) =>
  callTool(client, "get_related", { org: seed.orgSlug, ...args })

const refs = (result: CallToolResult): string[] =>
  (
    result.structuredContent?.results as Array<{ ref: string }> | undefined
  )?.map((item) => item.ref) ?? []

const errorCode = (result: CallToolResult): unknown => {
  expect(result.isError).toBe(true)
  return (result._meta?.[TOOL_ERROR_META_KEY] as { code?: string })?.code
}

describe("get_related through the MCP client on live Postgres and FalkorDB", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://search-model.test/v1")
    modelServer.listen({ onUnhandledRequest: "bypass" })
    seed = await seedOrg()
    await seedRelatedWorkspace({
      seed,
      slug: "platform",
      sha: sha("a"),
      units: platformUnits,
    })
    await seedRelatedWorkspace({
      seed,
      slug: "payments",
      sha: sha("b"),
      units: paymentsUnits,
      chunks: true,
    })
    queueRevision = (
      await seedRelatedWorkspace({
        seed,
        slug: "queue",
        sha: sha("d"),
        units: platformUnits,
      })
    ).revision
    await seedRelatedWorkspace({
      seed,
      slug: "ending",
      sha: sha("f"),
      units: endingUnits,
    })
    client = await connectToolClient(seed, getRelatedTool)
  }, 60_000)
  afterEach(() => {
    vi.useRealTimers()
  })
  afterAll(async () => {
    await client?.close()
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await dropOrgGraph(seed.orgId)
      await cleanupSeededOrg(seed)
    }
    await closeGraphDb()
    modelServer.close()
    vi.unstubAllEnvs()
  })

  it("ranks who depends on a library and who owns them (design example 2)", async () => {
    const result = await related({
      workspace: "platform",
      seeds: [limiter],
      intent: "dependencies",
      direction: "in",
      predicates: ["DEPENDS_ON", "OWNS"],
      kinds: ["Service", "Team"],
      maxDepth: 2,
      diversity: 0.5,
      limit: 6,
    })
    expect(result.isError).not.toBe(true)
    // Services lead by edge confidence; diversity brings a Team in at once.
    expect(refs(result)).toEqual([
      "knowledge/services/payments-api.md",
      "knowledge/services/gateway.md",
      "knowledge/teams/payments.md",
      "knowledge/services/search-api.md",
      "knowledge/teams/edge.md",
      "knowledge/teams/discovery.md",
    ])
    expect(result.structuredContent).toMatchObject({
      workspace: "platform",
      served: { branch: "main", sha: sha("a") },
      partial: false,
      explored: { nodes: 7, edges: 6 },
    })
    const first = (
      result.structuredContent?.results as Array<{
        path: Array<{ from: string; to: string; predicate: string }>
      }>
    )[0]
    expect(first?.path).toMatchObject([
      {
        from: "knowledge/services/payments-api.md",
        to: limiter,
        predicate: "DEPENDS_ON",
      },
    ])
  })

  it("walks only the predicates it is given", async () => {
    const withDoc = await related({
      workspace: "platform",
      seeds: [limiter],
      direction: "in",
      kinds: ["Doc"],
    })
    expect(refs(withDoc)).toEqual(["knowledge/docs/overview.md"])
    const filtered = await related({
      workspace: "platform",
      seeds: [limiter],
      direction: "in",
      predicates: ["DEPENDS_ON"],
      kinds: ["Doc"],
    })
    expect(refs(filtered)).toEqual([])
    const lowerCase = await related({
      workspace: "platform",
      seeds: [limiter],
      direction: "in",
      predicates: ["depends_on"],
    })
    expect(refs(lowerCase)).toEqual(
      refs(
        await related({
          workspace: "platform",
          seeds: [limiter],
          direction: "in",
          predicates: ["DEPENDS_ON"],
        }),
      ),
    )
    expect(refs(lowerCase)).toContain("knowledge/services/payments-api.md")
  })

  it("adds the results of all edges after a short intent walk, but not for explicit predicates", async () => {
    const gateway = "knowledge/services/gateway.md"
    // The ownership walk finds only the owner. The walk of all edges adds
    // the library, the services that use it, and the doc after the owner.
    const byIntent = await related({
      workspace: "platform",
      seeds: [gateway],
      intent: "ownership",
    })
    expect(byIntent.isError).not.toBe(true)
    expect(refs(byIntent)[0]).toBe("knowledge/teams/edge.md")
    expect([...refs(byIntent)].sort()).toEqual([
      "knowledge/docs/overview.md",
      limiter,
      "knowledge/services/payments-api.md",
      "knowledge/services/search-api.md",
      "knowledge/teams/edge.md",
    ])
    expect(byIntent.structuredContent).toMatchObject({
      partial: false,
      explored: { nodes: 6, edges: 5 },
    })
    // A limit that the intent walk fills adds nothing.
    expect(
      refs(
        await related({
          workspace: "platform",
          seeds: [gateway],
          intent: "ownership",
          limit: 1,
        }),
      ),
    ).toEqual(["knowledge/teams/edge.md"])
    const explicit = await related({
      workspace: "platform",
      seeds: [gateway],
      intent: "ownership",
      predicates: ["OWNS"],
    })
    expect(refs(explicit)).toEqual(["knowledge/teams/edge.md"])
  })

  it("filters the results by kind but walks through the other kinds", async () => {
    const result = await related({
      workspace: "platform",
      seeds: [limiter],
      intent: "dependencies",
      direction: "in",
      predicates: ["DEPENDS_ON", "OWNS"],
      kinds: ["Team"],
    })
    expect(refs(result).sort()).toEqual([
      "knowledge/teams/discovery.md",
      "knowledge/teams/edge.md",
      "knowledge/teams/payments.md",
    ])
    // The Services are in the walk, though they are not in the results.
    expect(result.structuredContent?.explored).toEqual({ nodes: 7, edges: 6 })
  })

  it("ranks incident context with graph proximity (design example 1)", async () => {
    const result = await related({
      workspace: "payments",
      seeds: [checkout],
      intent: "why",
      validAt: "2026-10-14T00:00:00Z",
      limit: 5,
    })
    expect(result.isError).not.toBe(true)
    expect(refs(result)).toEqual([
      "knowledge/databases/payments-db.md",
      "pagerduty/incidents/q7.md",
      "knowledge/decisions/adr-012.md",
      "linear/issues/PAY-311.md",
      "knowledge/runbooks/db-connection-saturation.md",
    ])
    const decision = (
      result.structuredContent?.results as Array<{
        ref: string
        path: Array<{ from: string; to: string; predicate: string }>
      }>
    ).find((item) => item.ref === "knowledge/decisions/adr-012.md")
    // The path keeps the stored direction of each edge.
    expect(decision?.path).toMatchObject([
      {
        from: checkout,
        to: "knowledge/databases/payments-db.md",
        predicate: "DEPENDS_ON",
      },
      {
        from: "knowledge/decisions/adr-012.md",
        to: "knowledge/databases/payments-db.md",
        predicate: "INFLUENCES",
      },
    ])
  })

  it("lets the query move the unit that matches it to the top", async () => {
    const result = await related({
      workspace: "payments",
      seeds: [checkout],
      query: "connection pool exhaustion after deploy",
      intent: "why",
      validAt: "2026-10-14T00:00:00Z",
      limit: 5,
    })
    expect(result.isError).not.toBe(true)
    expect(refs(result)[0]).toBe("pagerduty/incidents/q7.md")
    expect(refs(result)).toHaveLength(5)
    expect(result.structuredContent?.results).toMatchObject([
      { ref: "pagerduty/incidents/q7.md", queryMatch: 1 },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ])
  })

  it("includes edges that ended when the window covers them", async () => {
    const window = await related({
      workspace: "payments",
      seeds: [checkout],
      intent: "why",
      validBetween: {
        from: "2026-06-15T00:00:00Z",
        to: "2026-06-20T00:00:00Z",
      },
      limit: 5,
    })
    expect(refs(window)).toEqual([
      "knowledge/databases/payments-db.md",
      "pagerduty/incidents/q3.md",
      "knowledge/decisions/adr-012.md",
      "knowledge/runbooks/db-connection-saturation.md",
    ])
    const now = await related({
      workspace: "payments",
      seeds: [checkout],
      intent: "why",
      validAt: "2026-10-14T00:00:00Z",
    })
    expect(refs(now)).not.toContain("pagerduty/incidents/q3.md")
  })

  it("returns the seeds only on request and omits paths without explain", async () => {
    const result = await related({
      workspace: "payments",
      seeds: [checkout],
      includeSeeds: true,
      explain: false,
      validAt: "2026-10-14T00:00:00Z",
    })
    expect(refs(result)).toContain(checkout)
    for (const item of result.structuredContent?.results as object[]) {
      expect(item).not.toHaveProperty("path")
    }
  })

  it("serves page 2 from the cache, with no graph query", async () => {
    const args = {
      workspace: "queue",
      seeds: [limiter],
      intent: "dependencies",
      direction: "in",
      predicates: ["DEPENDS_ON", "OWNS"],
      kinds: ["Service", "Team"],
      diversity: 0.5,
      limit: 2,
    }
    const first = await related(args)
    expect(refs(first)).toEqual([
      "knowledge/services/payments-api.md",
      "knowledge/services/gateway.md",
    ])
    const cursor = first.structuredContent?.cursor as string
    expect(cursor).toEqual(expect.any(String))

    await deleteRevisionGraph(seed, queueRevision)
    expect(
      await hasWorkspaceGraph({
        orgId: seed.orgId,
        orgSlug: seed.orgSlug,
        revision: queueRevision,
      }),
    ).toBe(false)

    const second = await related({ ...args, cursor })
    expect(second.isError).not.toBe(true)
    expect(refs(second)).toEqual([
      "knowledge/teams/payments.md",
      "knowledge/services/search-api.md",
    ])
    const third = await related({
      ...args,
      cursor: second.structuredContent?.cursor,
    })
    expect(refs(third)).toEqual([
      "knowledge/teams/edge.md",
      "knowledge/teams/discovery.md",
    ])
    expect(third.structuredContent?.cursor).toBeUndefined()
  })

  it("ranks a page after the cache entry ended as of the time of the first page", async () => {
    const args = {
      workspace: "ending",
      seeds: ["knowledge/ending.md"],
      direction: "out",
      limit: 1,
    }
    const all = refs(await related({ ...args, limit: 10 }))
    expect(all).toHaveLength(3)
    const first = await related(args)
    const paged = refs(first)
    let cursor = first.structuredContent?.cursor as string
    expect(cursor).toEqual(expect.any(String))

    // The cache keeps an entry for 10 minutes; the edge to y ends in 1 hour.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 3_600_000 })
    while (cursor) {
      const page = await related({ ...args, cursor })
      expect(page.isError).not.toBe(true)
      paged.push(...refs(page))
      cursor = page.structuredContent?.cursor as string
    }
    expect(paged).toEqual(all)
    expect(paged).toContain("knowledge/y.md")

    // A new call after that time does not walk the ended edge.
    expect(refs(await related({ ...args, limit: 10 }))).not.toContain(
      "knowledge/y.md",
    )
  })

  it("refuses to rank when the served revision is no longer the projection", async () => {
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, "platform")),
    )
    const input = z
      .object(getRelatedInputShape)
      .parse({ workspace: "platform", seeds: [limiter] })
    const org = { id: seed.orgId, slug: seed.orgSlug }
    const workspace = { id: row?.id as string, slug: "platform" }
    // The call resolved the Workspace at SHA "c"; the projection holds "a".
    await expect(
      rankWorkspaceRelated(org, workspace, sha("c"), input, new Date()),
    ).rejects.toMatchObject({
      code: "workspace_not_ready",
      message: expect.stringContaining("new revision"),
    })
    const ranking = await rankWorkspaceRelated(
      org,
      workspace,
      sha("a"),
      input,
      new Date(),
    )
    expect(ranking.results.length).toBeGreaterThan(0)
  })

  it("gives the walk of all edges only the budget that the intent walk left", async () => {
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, "platform")),
    )
    const input = z.object(getRelatedInputShape).parse({
      workspace: "platform",
      seeds: ["knowledge/services/gateway.md"],
      intent: "ownership",
    })
    // The ownership walk uses 2 of 3 nodes and 1 of 2 edges.
    const ranking = await rankWorkspaceRelated(
      { id: seed.orgId, slug: seed.orgSlug },
      { id: row?.id as string, slug: "platform" },
      sha("a"),
      input,
      new Date(),
      { caps: { maxNodes: 3, maxEdges: 2 } },
    )
    // One node and one edge remain: the seed fits, and nothing new does.
    expect(ranking.explored).toEqual({ nodes: 2, edges: 1 })
  })

  it("refuses a cursor of another call and a cursor after a new revision", async () => {
    const first = await related({
      workspace: "payments",
      seeds: [checkout],
      limit: 1,
    })
    const cursor = first.structuredContent?.cursor as string
    expect(cursor).toEqual(expect.any(String))
    expect(
      errorCode(
        await related({
          workspace: "payments",
          seeds: ["pagerduty/incidents/q7.md"],
          limit: 1,
          cursor,
        }),
      ),
    ).toBe("invalid_cursor")

    const move = (to: string) =>
      withOrgDbContext(seed.orgId, async (db) => {
        const [row] = await db
          .select({ revision: workspaces.activeRevision })
          .from(workspaces)
          .where(eq(workspaces.slug, "payments"))
        await db
          .update(workspaces)
          .set({
            activeRevision: row?.revision && { ...row.revision, sha: to },
            activeProjectionSha: to,
          })
          .where(eq(workspaces.slug, "payments"))
      })
    await move(sha("c"))
    try {
      expect(
        errorCode(
          await related({
            workspace: "payments",
            seeds: [checkout],
            limit: 1,
            cursor,
          }),
        ),
      ).toBe("stale_cursor")
    } finally {
      await move(sha("b"))
    }
  })

  it("refuses bad arguments with a code the agent can act on", async () => {
    expect(
      errorCode(
        await related({ workspace: "payments", seeds: [checkout, "none.md"] }),
      ),
    ).toBe("unknown_ref")
    const unknown = await related({ workspace: "payments", seeds: ["none.md"] })
    expect(unknown.content?.[0]).toMatchObject({
      text: expect.stringContaining("none.md"),
    })
    expect(
      errorCode(await related({ workspace: "payments", seeds: ["../x.md"] })),
    ).toBe("invalid_ref")
    expect(
      errorCode(await related({ workspace: "missing", seeds: [checkout] })),
    ).toBe("workspace_not_found")
    expect(
      errorCode(
        await callTool(client, "get_related", {
          org: "no-such-org",
          workspace: "payments",
          seeds: [checkout],
        }),
      ),
    ).toBe("org_not_found")
    expect(
      errorCode(
        await related({
          workspace: "payments",
          seeds: [checkout],
          validAt: "2026-10-14T00:00:00Z",
          validBetween: {
            from: "2026-06-15T00:00:00Z",
            to: "2026-06-20T00:00:00Z",
          },
        }),
      ),
    ).toBe("invalid_argument")
  })

  it("refuses an option that is out of range", async () => {
    for (const bad of [
      { restart: 1 },
      { restart: 0 },
      { queryWeight: 1.5 },
      { diversity: -0.1 },
      { hubPenalty: -1 },
      { recencyHalfLifeDays: 0 },
      { maxDepth: 5 },
    ]) {
      // The SDK reports a schema failure as an error result or as a protocol error.
      const refused = await related({
        workspace: "payments",
        seeds: [checkout],
        ...bad,
      }).then(
        (result) => result.isError === true,
        () => true,
      )
      expect(refused, JSON.stringify(bad)).toBe(true)
    }
  })

  it("says that the graph is not ready for a Workspace with no active revision", async () => {
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: `ws_rel_legacy_${Date.now()}`,
        orgId: seed.orgId,
        slug: "legacy",
        displayName: "Legacy",
        workspaceRepositoryUrl: "https://git.example.test/acme/legacy.git",
        desiredDefaultBranch: "main",
        activeProjectionSha: sha("e"),
      })
      await db.insert(workspaces).values({
        id: `ws_rel_empty_${Date.now()}`,
        orgId: seed.orgId,
        slug: "empty",
        displayName: "Empty",
        workspaceRepositoryUrl: "https://git.example.test/acme/empty.git",
      })
    })
    for (const slug of ["legacy", "empty"]) {
      const result = await related({ workspace: slug, seeds: [checkout] })
      expect(errorCode(result)).toBe("workspace_not_ready")
      expect(result._meta?.[TOOL_ERROR_META_KEY]).toMatchObject({
        retryable: true,
      })
    }
    const legacy = await related({ workspace: "legacy", seeds: [checkout] })
    expect(JSON.stringify(legacy.content)).toContain("needs a hydrate")
    expect(JSON.stringify(legacy.content)).not.toContain("few minutes")
  })
})
