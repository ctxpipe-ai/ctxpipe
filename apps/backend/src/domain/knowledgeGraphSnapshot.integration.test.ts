/**
 * Integration: knowledge graph snapshot should surface org-level "last updated"
 * from Postgres (`repositories.updated_at`), not from a truncated graph edge
 * sample — otherwise the UI "Updated" label can stay stuck on an old date
 * after re-indexing (CTX-94).
 *
 * Mocks the graph driver (no Falkor/Redis). Skips when DATABASE_URL is unset
 * or Postgres is unreachable.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { initDb, withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { generateObjectId } from "../lib/id.js"
import { isPostgresReachable } from "../test/postgresReachable.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const describeIntegration =
  !connectionString || !(await isPostgresReachable(connectionString))
    ? describe.skip
    : describe

const { mockGraph } = vi.hoisted(() => {
  /** Deterministic “old” graph activity so the edge-sample max is not the reindex time. */
  const staleEdgeTime = "2020-01-15T12:00:00.000Z"
  return {
    mockGraph: {
      executeQuery: vi.fn(async (query: string) => {
        if (query.includes("RETURN count(n)")) {
          return { records: [{ get: (k: string) => (k === "c" ? 2 : null) }] }
        }
        if (query.includes("RETURN count(r)")) {
          return { records: [{ get: (k: string) => (k === "c" ? 1 : null) }] }
        }
        if (query.includes("MATCH (n)") && query.includes("n.id")) {
          return {
            records: [
              {
                get: (k: string) => {
                  const row: Record<string, unknown> = {
                    id: "node_a",
                    kind: "Service",
                    name: "A",
                    summary: null,
                  }
                  return row[k]
                },
              },
            ],
          }
        }
        if (query.includes("MATCH (a)-[r]")) {
          return {
            records: [
              {
                get: (k: string) => {
                  const row: Record<string, unknown> = {
                    sourceId: "node_a",
                    targetId: "node_b",
                    predicate: "USES",
                    lastObservedAt: staleEdgeTime,
                    confidence: 0.8,
                  }
                  return row[k]
                },
              },
            ],
          }
        }
        return { records: [] }
      }),
    },
  }
})

vi.mock("../platform/graph/client.js", () => ({
  withGraphClient: async (
    _args: { orgId: string; orgSlug: string },
    fn: () => Promise<unknown>,
  ) => fn(),
  getGraphClient: () => mockGraph,
}))

import { getKnowledgeGraphSnapshot } from "./knowledgeGraphSnapshot.js"

const ORG_ID = `org_kg_metrics_${Date.now()}`
const REPO_ID = generateObjectId("repo")
const reindexTouch = new Date("2026-04-28T16:50:00.000Z")

beforeAll(() => {
  if (!connectionString) return
  initDb(connectionString)
})

afterAll(async () => {
  if (!connectionString) return
  try {
    const { getSystemDb, closeDb } = await import("../db/client.js")
    const db = getSystemDb()
    await db.delete(repositories).where(eq(repositories.orgId, ORG_ID))
    await closeDb()
  } catch {
    // Best-effort cleanup; DB may already be closed
  }
})

describeIntegration("getKnowledgeGraphSnapshot (integration)", () => {
  it("sets metrics.lastUpdatedAt from max(repositories.updated_at), not only edge lastObservedAt", async () => {
    await withOrgDbContext(ORG_ID, async () => {
      const { getOrgDb } = await import("../db/client.js")
      const db = getOrgDb()
      await db.insert(repositories).values({
        id: REPO_ID,
        orgId: ORG_ID,
        name: "owner/snapshot-test-repo",
        gitUrl: "https://github.com/owner/snapshot-test-repo.git",
        indexReady: true,
        lastIngestedHash: "abc123",
        updatedAt: reindexTouch,
      })
    })

    const snap = await getKnowledgeGraphSnapshot(ORG_ID, "test-org", {
      nodeLimit: 10,
      edgeLimit: 10,
    })

    expect(snap.metrics.lastUpdatedAt).toBe(reindexTouch.toISOString())
    const edgeMax = Math.max(
      ...snap.edges
        .map((e) => (e.lastObservedAt ? Date.parse(e.lastObservedAt) : 0))
        .filter((n) => Number.isFinite(n)),
    )
    const metricsMs = snap.metrics.lastUpdatedAt
      ? Date.parse(snap.metrics.lastUpdatedAt)
      : NaN
    expect(metricsMs).toBeGreaterThan(edgeMax)
  })
})
