import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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
import { getRelatedTool } from "./get-related.js"

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
    client = await connectToolClient(seed, getRelatedTool)
  }, 60_000)
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
  })
})
