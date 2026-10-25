import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { inArray } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  embeddingModelServer,
  type SeedUnit,
  seedKnowledgeUnits,
  seedKnowledgeWorkspace,
} from "../../test/knowledge-search-fixture.js"
import { searchKnowledge } from "./knowledge-search.js"
import { WORKSPACE_CHAT_TOOLS } from "./workspace-chat-tools.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const orgId = `org_test_ksearch_${suffix}`
const otherOrgId = `org_test_ksearch_other_${suffix}`
const main = `ws_ksearch_main_${suffix}`
const second = `ws_ksearch_second_${suffix}`
const ties = `ws_ksearch_ties_${suffix}`
const foreign = `ws_ksearch_foreign_${suffix}`
const sha = "a".repeat(40)

const embeddingRequests: string[] = []
const modelServer = embeddingModelServer(embeddingRequests)

const units: SeedUnit[] = [
  {
    id: `unit_runbook_${suffix}`,
    workspaceId: main,
    path: "runbooks/payment-gateway.md",
    kind: "Runbook",
    title: "Payment gateway runbook",
    source: "authored",
    updatedAt: "2026-01-10T00:00:00Z",
    body: [
      "# Payment gateway runbook",
      "",
      "Restart the gateway pods when downtime hits checkout. Handbook entry.",
      "",
      "## Contacts",
      "",
      "Page the payments team on call.",
    ].join("\n"),
  },
  {
    id: `unit_ledger_${suffix}`,
    workspaceId: main,
    path: "services/ledger.md",
    kind: "Service",
    title: "Ledger service",
    source: "authored",
    updatedAt: "2026-03-01T00:00:00Z",
    body: "# Ledger service\n\nThe ledger rejects writes with ERR_LEDGER_7731 when a shard is full. Handbook entry.",
  },
  {
    id: `unit_reconcile_${suffix}`,
    workspaceId: main,
    path: "services/reconcile.md",
    kind: "Service",
    title: "Ledger reconciliation",
    source: "authored",
    updatedAt: "2026-02-01T00:00:00Z",
    body: "# Ledger reconciliation\n\nThe ledger job compares ledger totals with the ledger archive. Handbook entry.",
  },
  {
    id: `unit_ticket_${suffix}`,
    workspaceId: main,
    path: "linear/ENG-1.md",
    kind: "Ticket",
    title: "Flaky pipeline",
    source: "linear",
    updatedAt: "2026-05-01T00:00:00Z",
    body: "# Flaky pipeline\n\nThe job fails on retries. Handbook entry.",
  },
  {
    id: `unit_zebra_${suffix}`,
    workspaceId: main,
    path: "decisions/rollout.md",
    kind: "Decision",
    title: "Zebracorn rollout plan",
    source: "authored",
    updatedAt: "2026-04-01T00:00:00Z",
    body: "We move tenants in three waves. Handbook entry.",
  },
  {
    id: `unit_old_${suffix}`,
    workspaceId: main,
    path: "decisions/old-queue.md",
    kind: "Decision",
    title: "Old queue",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Old queue\n\nUse the old queue. Handbook entry.",
    claims: [{ validFrom: "2024-01-01", validTo: "2025-12-31" }],
  },
  {
    id: `unit_new_${suffix}`,
    workspaceId: main,
    path: "decisions/new-queue.md",
    kind: "Decision",
    title: "New queue",
    source: "authored",
    updatedAt: "2026-01-01T00:00:00Z",
    body: "# New queue\n\nUse the new queue. Handbook entry.",
    claims: [{ validFrom: "2026-01-01" }],
  },
  {
    id: `unit_stamped_${suffix}`,
    workspaceId: main,
    path: "decisions/stamped.md",
    kind: "Decision",
    title: "Stamped decision",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Stamped decision\n\nThe stamp holds a commit. Handbook entry.",
    // Hydrate stores a Git SHA here until a later job rewrites it.
    claims: [{ validFrom: "f3a9c1d2e4b5a6978877665544332211aabbccdd" }],
  },
  {
    id: `unit_offset_${suffix}`,
    workspaceId: main,
    path: "decisions/offset.md",
    kind: "Decision",
    title: "Offset decision",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Offset decision\n\nThe window starts at local midnight. Handbook entry.",
    // 2026-01-01T00:00:00Z, written with an offset.
    claims: [{ validFrom: "2026-01-01T10:00:00+10:00" }],
  },
  {
    id: `unit_badday_${suffix}`,
    workspaceId: main,
    path: "decisions/bad-day.md",
    kind: "Decision",
    title: "Bad day decision",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Bad day decision\n\nThe date does not exist. Handbook entry.",
    claims: [{ validFrom: "2024-02-30" }],
  },
  {
    id: `unit_junk_${suffix}`,
    workspaceId: main,
    path: "decisions/junk.md",
    kind: "Decision",
    title: "Junk decision",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Junk decision\n\nThe date has a tail. Handbook entry.",
    claims: [{ validFrom: "2024-01-01 junk" }],
  },
  {
    id: `unit_billing_${suffix}`,
    workspaceId: main,
    path: "systems/billing.md",
    kind: "System",
    title: "Billing service",
    source: "authored",
    updatedAt: "2025-01-01T00:00:00Z",
    body: "# Billing service\n\nThe service charges cards. Handbook entry.",
    // The owner lives in front matter only, so no chunk text names it.
    claims: [{ predicate: "OWNED_BY", to: "unit_team_payments" }],
  },
  {
    id: `unit_second_${suffix}`,
    workspaceId: second,
    path: "notes/second.md",
    kind: "Note",
    title: "Second note",
    source: "authored",
    updatedAt: "2026-01-01T00:00:00Z",
    body: "# Second note\n\nAnother handbook entry.",
  },
]

const tieId = (index: number) =>
  `unit_tie_${String(index).padStart(3, "0")}_${suffix}`

const ALL_MAIN = units
  .filter((unit) => unit.workspaceId === main)
  .map((unit) => unit.id)

function search(
  input: Partial<Parameters<typeof searchKnowledge>[0]> & { query: string },
) {
  return searchKnowledge({ orgId, workspaceIds: [main], ...input })
}

const ids = (hits: Awaited<ReturnType<typeof searchKnowledge>>) =>
  hits.map((hit) => hit.unitId).sort()

describe("searchKnowledge (Postgres)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    modelServer.listen({ onUnhandledRequest: "error" })
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://search-model.test/v1")
    initDb(connectionString)
    for (const id of [main, second, ties])
      await seedKnowledgeWorkspace(orgId, id, sha)
    await seedKnowledgeWorkspace(otherOrgId, foreign, sha)
    await seedKnowledgeUnits(orgId, sha, units)
    // 130 units with the same text, so every rank ties. They go in against
    // the id order, so the row order differs from the order the ranks must give.
    await seedKnowledgeUnits(
      orgId,
      sha,
      Array.from({ length: 130 }, (_, index) => ({
        id: tieId(129 - index),
        workspaceId: ties,
        path: `ties/${129 - index}.md`,
        title: "Tie note",
        updatedAt: "2026-01-01T00:00:00Z",
        body: "# Tie note\n\nTiebreak marker text.",
      })),
    )
    await seedKnowledgeUnits(otherOrgId, sha, [
      {
        id: `unit_foreign_${suffix}`,
        workspaceId: foreign,
        path: "notes/foreign.md",
        title: "Foreign runbook",
        updatedAt: "2026-01-01T00:00:00Z",
        body: "# Foreign runbook\n\nHandbook entry about downtime and ERR_LEDGER_7731.",
      },
    ])
  }, 60_000)

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [main, second, ties])),
    )
    await withOrgDbContext(otherOrgId, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [foreign])),
    )
    await closeDb()
    modelServer.close()
    vi.unstubAllEnvs()
  })

  it("ranks the unit with an exact keyword first", async () => {
    const hits = await search({ query: "ERR_LEDGER_7731" })
    expect(hits[0]?.unitId).toBe(`unit_ledger_${suffix}`)
    expect(hits[0]).toMatchObject({
      workspaceId: main,
      path: "services/ledger.md",
      kind: "Service",
      title: "Ledger service",
      source: "authored",
      projectionSha: sha,
      startLine: 1,
      endLine: 3,
    })
    expect(hits[0]?.text).toContain("ERR_LEDGER_7731")
    expect(hits[0]?.updatedAt.toISOString()).toBe("2026-03-01T00:00:00.000Z")
  })

  it("ranks a paraphrase first through the embedding", async () => {
    embeddingRequests.length = 0
    const hits = await search({ query: "what to do in an outage" })
    expect(embeddingRequests).toEqual(["what to do in an outage"])
    expect(hits[0]?.unitId).toBe(`unit_runbook_${suffix}`)
  })

  it("finds a unit whose title alone matches", async () => {
    const hits = await search({ query: "zebracorn" })
    expect(hits[0]?.unitId).toBe(`unit_zebra_${suffix}`)
  })

  it("returns one hit for each unit, with the line range of the best chunk", async () => {
    const hits = await search({ query: "contacts payments team on call" })
    const runbook = hits.filter(
      (hit) => hit.unitId === `unit_runbook_${suffix}`,
    )
    expect(runbook).toHaveLength(1)
    expect(runbook[0]).toMatchObject({ startLine: 5, endLine: 7 })
    expect(runbook[0]?.text).toContain("Payment gateway runbook > Contacts")
  })

  it("searches only the given Workspaces", async () => {
    expect(ids(await search({ query: "handbook", limit: 50 }))).toEqual(
      [...ALL_MAIN].sort(),
    )
    expect(
      ids(
        await search({
          query: "handbook",
          workspaceIds: [main, second],
          limit: 50,
        }),
      ),
    ).toEqual([...ALL_MAIN, `unit_second_${suffix}`].sort())
    expect(
      ids(await search({ query: "handbook", workspaceIds: [second] })),
    ).toEqual([`unit_second_${suffix}`])
  })

  it("filters by kind, path prefix, source and update time", async () => {
    expect(
      ids(await search({ query: "handbook", kinds: ["Service", "Ticket"] })),
    ).toEqual(
      [
        `unit_ledger_${suffix}`,
        `unit_reconcile_${suffix}`,
        `unit_ticket_${suffix}`,
      ].sort(),
    )
    expect(
      ids(await search({ query: "handbook", pathPrefix: "services/" })),
    ).toEqual([`unit_ledger_${suffix}`, `unit_reconcile_${suffix}`].sort())
    // A prefix is literal: `_` and `%` are not patterns.
    expect(await search({ query: "handbook", pathPrefix: "s%" })).toEqual([])
    expect(
      ids(await search({ query: "handbook", sources: ["linear"] })),
    ).toEqual([`unit_ticket_${suffix}`])
    expect(
      ids(
        await search({
          query: "handbook",
          updatedAfter: new Date("2026-03-01T00:00:00Z"),
        }),
      ),
    ).toEqual([`unit_ticket_${suffix}`, `unit_zebra_${suffix}`].sort())
  })

  it("filters by validity: a unit with no windowed claim always matches", async () => {
    const always = ALL_MAIN.filter(
      (id) =>
        id !== `unit_old_${suffix}` &&
        id !== `unit_new_${suffix}` &&
        id !== `unit_offset_${suffix}`,
    )
    expect(
      ids(
        await search({
          query: "handbook",
          validAt: new Date("2025-06-01T00:00:00Z"),
          limit: 50,
        }),
      ),
    ).toEqual([...always, `unit_old_${suffix}`].sort())
    expect(
      ids(
        await search({
          query: "handbook",
          validAt: new Date("2026-06-01T00:00:00Z"),
          limit: 50,
        }),
      ),
    ).toEqual([...always, `unit_new_${suffix}`, `unit_offset_${suffix}`].sort())
  })

  it("reads a validity bound as a time only when it starts as a date", async () => {
    const wanted = [`unit_stamped_${suffix}`, `unit_offset_${suffix}`]
    // A Git SHA in validFrom is no window, so that unit always matches.
    // An offset time compares as an instant: 10:00+10:00 is 00:00Z.
    expect(
      ids(
        await search({
          query: "handbook",
          unitIds: wanted,
          validAt: new Date("2026-01-01T05:00:00Z"),
        }),
      ),
    ).toEqual(wanted.sort())
    expect(
      ids(
        await search({
          query: "handbook",
          unitIds: wanted,
          validAt: new Date("2025-12-31T23:30:00Z"),
        }),
      ),
    ).toEqual([`unit_stamped_${suffix}`])
  })

  it("reads a malformed validity bound as no window, not as an error", async () => {
    const wanted = [`unit_badday_${suffix}`, `unit_junk_${suffix}`]
    expect(
      ids(
        await search({
          query: "handbook",
          unitIds: wanted,
          validAt: new Date("2025-06-01T00:00:00Z"),
        }),
      ),
    ).toEqual(wanted.sort())
  })

  it("keeps only the given unit ids (the get_related filter)", async () => {
    const wanted = [`unit_runbook_${suffix}`, `unit_ticket_${suffix}`]
    expect(ids(await search({ query: "handbook", unitIds: wanted }))).toEqual(
      wanted.sort(),
    )
    expect(
      await search({ query: "handbook", unitIds: [`unit_foreign_${suffix}`] }),
    ).toEqual([])
    expect(await search({ query: "handbook", unitIds: [] })).toEqual([])
  })

  it("shows nothing of another org", async () => {
    expect(
      await searchKnowledge({
        orgId: otherOrgId,
        workspaceIds: [main],
        query: "handbook",
      }),
    ).toEqual([])
    expect(
      await searchKnowledge({
        orgId,
        workspaceIds: [foreign],
        query: "ERR_LEDGER_7731 downtime",
      }),
    ).toEqual([])
  })

  it("keeps lexical hits when the embedding model fails", async () => {
    modelServer.use(
      http.post("https://search-model.test/v1/embeddings", () =>
        HttpResponse.json({ error: { message: "down" } }, { status: 500 }),
      ),
    )
    try {
      const hits = await search({ query: "ERR_LEDGER_7731" })
      expect(hits[0]?.unitId).toBe(`unit_ledger_${suffix}`)
    } finally {
      modelServer.resetHandlers()
    }
  })

  it("breaks ties by key, so a page is a prefix of a longer page", async () => {
    const all = Array.from({ length: 50 }, (_, index) => tieId(index))
    const longest = await search({
      query: "tiebreak marker",
      workspaceIds: [ties],
      limit: 50,
    })
    // 130 chunks tie in both rankings; the 100 kept are the lowest keys.
    expect(longest.map((hit) => hit.unitId)).toEqual(all)
    for (const limit of [1, 7, 10, 33]) {
      const page = await search({
        query: "tiebreak marker",
        workspaceIds: [ties],
        limit,
      })
      expect(page.map((hit) => hit.unitId)).toEqual(all.slice(0, limit))
    }
  })

  it("serves chat hybrid_search from the chunks, with line ranges", async () => {
    const tool = WORKSPACE_CHAT_TOOLS.find((t) => t.name === "hybrid_search")
    const context = { orgId, orgSlug: `ksearch-${suffix}`, workspaceId: main }
    const titleOnly = String(
      await tool?.execute({ query: "zebracorn" }, { context }),
    )
    expect(titleOnly).toContain("decisions/rollout.md (lines 1-1)")
    const section = String(
      await tool?.execute(
        { query: "contacts payments team on call" },
        { context },
      ),
    )
    expect(section).toContain("runbooks/payment-gateway.md (lines 5-7)")
    expect(section).not.toContain("Restart the gateway pods")
  })

  it("gives chat the claims and the node id of each hit", async () => {
    const tool = WORKSPACE_CHAT_TOOLS.find((t) => t.name === "hybrid_search")
    const context = { orgId, orgSlug: `ksearch-${suffix}`, workspaceId: main }
    const answer = String(
      await tool?.execute(
        { query: "who owns the billing service" },
        { context },
      ),
    )
    expect(answer).toContain("systems/billing.md")
    expect(answer).toContain(`Node: unit_billing_${suffix}`)
    expect(answer).toContain("- OWNED_BY unit_team_payments")
  })
})
