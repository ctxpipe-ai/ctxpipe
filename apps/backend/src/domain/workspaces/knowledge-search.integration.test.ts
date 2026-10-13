import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { inArray, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
import { knowledgeChunkRows } from "./knowledge-chunks.js"
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
const large = `ws_ksearch_large_${suffix}`
const foreign = `ws_ksearch_foreign_${suffix}`
const sha = "a".repeat(40)

/**
 * A small concept embedding: synonyms share one dimension, so a paraphrase
 * is near its source text. Other words fall into hashed noise dimensions.
 */
const CONCEPTS: Record<string, number> = {
  outage: 0,
  downtime: 0,
  unavailable: 0,
  broken: 0,
  release: 1,
  deploy: 1,
  ship: 1,
}
function embedText(text: string): number[] {
  const vector: number[] = new Array(2000).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const concept = CONCEPTS[word]
    if (concept !== undefined) {
      vector[concept] = (vector[concept] ?? 0) + 5
      continue
    }
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    const dim = 8 + (hash % 56)
    vector[dim] = (vector[dim] ?? 0) + 1
  }
  if (!vector.some((value) => value !== 0)) vector[63] = 1
  return vector
}

const embeddingRequests: string[] = []
const modelServer = setupServer(
  http.post("https://search-model.test/v1/embeddings", async ({ request }) => {
    const body = (await request.json()) as { input: string[] }
    embeddingRequests.push(...body.input)
    return HttpResponse.json({
      data: body.input.map((text, index) => ({
        index,
        embedding: embedText(text),
      })),
    })
  }),
)

type SeedUnit = {
  id: string
  workspaceId: string
  path: string
  kind?: string
  title: string
  source?: string | null
  updatedAt: string
  body: string
  claims?: Array<{ validFrom?: string; validTo?: string }>
}

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

const ALL_MAIN = units
  .filter((unit) => unit.workspaceId === main)
  .map((unit) => unit.id)

async function seedWorkspace(org: string, id: string) {
  await withOrgDbContext(org, (db) =>
    db.insert(workspaces).values({
      id,
      orgId: org,
      slug: id,
      displayName: "Knowledge search fixture",
      workspaceRepositoryUrl: `https://github.com/example/${id}`,
      activeProjectionSha: sha,
    }),
  )
}

async function seedUnits(org: string, seed: SeedUnit[]) {
  await withOrgDbContext(org, async (db) => {
    await db.insert(workspaceKnowledgeUnits).values(
      seed.map((unit) => ({
        servingId: unit.id,
        orgId: org,
        workspaceId: unit.workspaceId,
        path: unit.path,
        kind: unit.kind ?? null,
        title: unit.title,
        source: unit.source ?? null,
        body: unit.body,
        projectionSha: sha,
        updatedAt: new Date(unit.updatedAt),
        claims: (unit.claims ?? []).map((claim) => ({
          to: "unit_elsewhere",
          predicate: "supersedes",
          confidence: null,
          validFrom: claim.validFrom ?? null,
          validTo: claim.validTo ?? null,
          source: null,
        })),
      })),
    )
    for (const unit of seed) {
      const rows = knowledgeChunkRows(
        [{ servingId: unit.id, body: unit.body, title: unit.title }],
        "fixture-model",
      )
      await db.insert(workspaceKnowledgeChunks).values(
        rows.map((row) => ({
          ...row,
          workspaceId: unit.workspaceId,
          orgId: org,
          embedding: embedText(row.text),
        })),
      )
    }
  })
}

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
    for (const id of [main, second, large]) await seedWorkspace(orgId, id)
    await seedWorkspace(otherOrgId, foreign)
    await seedUnits(orgId, units)
    await seedUnits(otherOrgId, [
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
      db
        .delete(workspaces)
        .where(inArray(workspaces.id, [main, second, large])),
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
      (id) => id !== `unit_old_${suffix}` && id !== `unit_new_${suffix}`,
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
    ).toEqual([...always, `unit_new_${suffix}`].sort())
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

  it("answers within the bound on 20,000 chunks", async () => {
    // 2,000 units of 10 chunks each, with random vectors, in one more
    // Workspace. Each HNSW insert is serial, so four transactions share the work.
    await withOrgDbContext(orgId, (db) =>
      db.execute(sql`
        INSERT INTO workspace_knowledge_units
          (serving_id, org_id, workspace_id, path, kind, title, source, body, projection_sha, updated_at)
        SELECT 'unit_large_' || g || '_' || ${suffix}, ${orgId}, ${large},
          'bulk/' || g || '.md', 'Note', 'Bulk note ' || g, 'authored',
          'bulk body', ${sha}, now()
        FROM generate_series(1, 2000) AS g
      `),
    )
    await Promise.all(
      [0, 1, 2, 3].map((part) =>
        withOrgDbContext(orgId, (db) =>
          db.execute(sql`
            INSERT INTO workspace_knowledge_chunks
              (workspace_id, unit_id, chunk_hash, occurrence, org_id, ordinal, start_line, end_line, text, embedding)
            SELECT ${large}, 'unit_large_' || u || '_' || ${suffix}, md5(u || ':' || c), 0, ${orgId}, c,
              c * 10 + 1, c * 10 + 9,
              'Bulk note ' || u || ' section ' || c || ' handbook words ' || md5(u || '-' || c),
              (SELECT array_agg(random()::real) FROM generate_series(1, 2000) WHERE u > 0 AND c >= 0)::vector
            FROM generate_series(${part * 500 + 1}::int, ${part * 500 + 500}::int) AS u,
              generate_series(0, 9) AS c
          `),
        ),
      ),
    )
    const runs: number[] = []
    for (let run = 0; run < 5; run++) {
      const started = performance.now()
      const hits = await searchKnowledge({
        orgId,
        workspaceIds: [main, large],
        query: "what to do in an outage",
        kinds: ["Runbook", "Note"],
      })
      runs.push(performance.now() - started)
      expect(hits[0]?.unitId).toBe(`unit_runbook_${suffix}`)
    }
    runs.sort((a, b) => a - b)
    const median = runs[2] ?? Number.POSITIVE_INFINITY
    // Local median: see the P2-3 ticket note. The bound leaves room for a loaded CI host.
    console.info(
      `knowledge search median on 20,000 chunks: ${median.toFixed(1)} ms`,
    )
    expect(median).toBeLessThan(1_000)
  }, 300_000)
})
