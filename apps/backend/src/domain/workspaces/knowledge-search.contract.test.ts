import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  embeddingModelServer,
  seedKnowledgeUnits,
  seedKnowledgeWorkspace,
} from "../../test/knowledge-search-fixture.js"
import { hnswCandidates, searchKnowledge } from "./knowledge-search.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const orgId = `org_test_kscale_${suffix}`
const small = `ws_kscale_small_${suffix}`
const bulk = `ws_kscale_bulk_${suffix}`
const sha = "a".repeat(40)
const runbook = `unit_runbook_${suffix}`
const ledger = `unit_ledger_${suffix}`
const modelServer = embeddingModelServer()
// This test does not exercise the HNSW scan cap on pgvector below 0.8, where a
// scope over 10,000 chunks can still lose vector hits.

// All the vectors of the bulk Workspace are nearer to the paraphrase query
// than the runbook is, and there are more of them than the 20,000 tuples that
// a filtered HNSW scan visits (hnsw.max_scan_tuples). If the planner walks the
// shared index, such a scan never reaches the small Workspace. The planner
// picks that plan by table statistics, so these tests do not force it. They
// prove the result: a small scope is scanned exactly, and a large one gets hits from both sides and reads the HNSW index.
const paraphrase = "what to do in an outage"

describe("searchKnowledge on a large shared index (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    modelServer.listen({ onUnhandledRequest: "error" })
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://search-model.test/v1")
    initDb(process.env.DATABASE_URL)
    for (const id of [small, bulk]) await seedKnowledgeWorkspace(orgId, id, sha)
    await seedKnowledgeUnits(orgId, sha, [
      {
        id: runbook,
        workspaceId: small,
        path: "runbooks/payment-gateway.md",
        kind: "Runbook",
        title: "Payment gateway runbook",
        updatedAt: "2026-01-10T00:00:00Z",
        body: "# Payment gateway runbook\n\nRestart the gateway pods when downtime hits checkout.",
      },
      {
        id: ledger,
        workspaceId: small,
        path: "services/ledger.md",
        kind: "Service",
        title: "Ledger service",
        updatedAt: "2026-03-01T00:00:00Z",
        body: "# Ledger service\n\nThe ledger rejects writes with ERR_LEDGER_7731 when a shard is full.",
      },
    ])
    // 2,050 units of 10 chunks each. Each HNSW insert is serial, so four
    // transactions share the work. A fixed seed makes the vectors repeatable.
    await withOrgDbContext(orgId, (db) =>
      db.execute(sql`
        INSERT INTO workspace_knowledge_units
          (serving_id, org_id, workspace_id, path, kind, title, source, body, projection_sha, updated_at)
        SELECT 'unit_bulk_' || g || '_' || ${suffix}, ${orgId}, ${bulk},
          'bulk/' || g || '.md', 'Note', 'Bulk note ' || g, 'authored',
          'bulk body', ${sha}, now()
        FROM generate_series(1, 2050) AS g
      `),
    )
    await Promise.all(
      [0, 1, 2, 3].map((part) =>
        withOrgDbContext(orgId, async (db) => {
          await db.execute(sql`SELECT setseed(${0.1 + part / 10})`)
          await db.execute(sql`
            INSERT INTO workspace_knowledge_chunks
              (workspace_id, unit_id, chunk_hash, occurrence, org_id, ordinal, start_line, end_line, text, embedding)
            SELECT ${bulk}, 'unit_bulk_' || u || '_' || ${suffix}, md5(u || ':' || c), 0, ${orgId}, c,
              c * 10 + 1, c * 10 + 9,
              'Bulk note ' || u || ' section ' || c || ' words ' || md5(u || '-' || c),
              (SELECT array_agg((CASE WHEN d = 1 THEN 5 ELSE random() * 0.05 END)::real)
                FROM generate_series(1, 2000) AS d WHERE u > 0 AND c >= 0)::vector
            FROM generate_series(${part * 520 + 1}::int, ${Math.min(part * 520 + 520, 2050)}::int) AS u,
              generate_series(0, 9) AS c
          `)
        }),
      ),
    )
  }, 600_000)

  afterAll(async () => {
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [small, bulk])),
    )
    await closeDb()
    modelServer.close()
    vi.unstubAllEnvs()
  })

  it("finds a paraphrase in a small Workspace on the vector side alone", async () => {
    const hits = await searchKnowledge({
      orgId,
      workspaceIds: [small],
      query: paraphrase,
    })
    expect(hits[0]?.unitId).toBe(runbook)
  }, 60_000)

  it("finds a paraphrase among a few unit ids", async () => {
    const hits = await searchKnowledge({
      orgId,
      workspaceIds: [small, bulk],
      query: paraphrase,
      unitIds: [runbook, ledger],
    })
    expect(hits.map((hit) => hit.unitId)).toEqual([runbook, ledger])
  }, 60_000)

  it("returns hits from both sides over 20,500 chunks", async () => {
    const hits = await searchKnowledge({
      orgId,
      workspaceIds: [small, bulk],
      query: `ERR_LEDGER_7731 ${paraphrase}`,
      limit: 10,
    })
    // Full text finds the ledger unit. The vector side gives the bulk units.
    expect(hits.map((hit) => hit.unitId)).toContain(ledger)
    expect(hits.some((hit) => hit.workspaceId === bulk)).toBe(true)
  }, 120_000)

  it("reads the nearest chunks through the HNSW index, not a scan of every chunk", async () => {
    // A wall-clock bound is not deterministic on a shared runner. The plan is.
    // With sequential scans off, the planner must use the HNSW index for this
    // query shape. A change that stops the index from serving the query, such
    // as a second sort key, makes it fail the plan.
    const vector = sql`${JSON.stringify(Array.from({ length: 2000 }, (_, d) => (d === 0 ? 1 : 0)))}::vector`
    const where = sql`c.workspace_id = ANY(${sql.param([small, bulk])}::text[])
      AND u.projection_sha = coalesce(w.active_revision->>'sha', w.active_projection_sha)`
    const plan = await withOrgDbContext(orgId, async (db) => {
      await db.execute(sql`ANALYZE workspace_knowledge_chunks`)
      // The row estimate for the org filter depends on the other orgs in the
      // shared test database, so the planner may pick the org index on a cost
      // tie. Without a sort, only the HNSW index can give the distance order.
      await db.execute(sql`SET LOCAL enable_seqscan = off`)
      await db.execute(sql`SET LOCAL enable_sort = off`)
      await db.execute(sql`SET LOCAL enable_incremental_sort = off`)
      const explained = await db.execute<{ "QUERY PLAN": unknown }>(
        sql`EXPLAIN (FORMAT JSON) ${hnswCandidates(vector, where)}`,
      )
      // The vector literal would fill the failure message, so keep the nodes.
      return JSON.stringify(explained.rows[0]?.["QUERY PLAN"]).replace(
        /'\[[^\]]*\]'::vector/g,
        "<vector>",
      )
    })
    expect(plan).toContain("workspace_knowledge_chunks_embedding_idx")
    expect(plan).not.toMatch(
      /"Node Type":"Seq Scan","[^}]*"Relation Name":"workspace_knowledge_chunks"/,
    )
  }, 120_000)
})
