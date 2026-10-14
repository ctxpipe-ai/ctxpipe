import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { closeGraphDb } from "../../platform/graph/client.js"
import {
  callTool,
  connectToolClient,
  dropOrgGraph,
  type RelatedUnit,
  seedRelatedWorkspace,
} from "../../test/related-fixture.js"
import { getRelatedTool } from "./get-related.js"

const NODES = 5_000
const CLAIMS_PER_NODE = 10

/** A graph of 50,000 edges whose targets favor a few hubs. */
function hubGraph(): RelatedUnit[] {
  let state = 12_345
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
  return Array.from({ length: NODES }, (_, index) => ({
    path: `graph/n${index}.md`,
    kind: ["Service", "Decision", "Incident", "Runbook"][index % 4] as string,
    claims: Array.from({ length: CLAIMS_PER_NODE }, () => {
      const target = Math.min(NODES - 1, Math.floor(random() ** 3 * NODES))
      return {
        to: `graph/n${target === index ? (target + 1) % NODES : target}.md`,
        predicate: ["DEPENDS_ON", "INFLUENCES", "AFFECTS"][
          Math.floor(random() * 3)
        ] as string,
        confidence: 0.3 + random() * 0.65,
      }
    }),
  }))
}

let seed: SeededOrg
let client: Client

describe("get_related latency on a 50,000-edge graph", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
    seed = await seedOrg()
    await seedRelatedWorkspace({
      seed,
      slug: "large",
      sha: "f".repeat(40),
      units: hubGraph(),
    })
    client = await connectToolClient(seed, getRelatedTool)
  }, 300_000)
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
  })

  it(
    "answers a depth 2 call with a p95 under 300 ms",
    { timeout: 120_000 },
    async () => {
      const call = (index: number) =>
        callTool(client, "get_related", {
          org: seed.orgSlug,
          workspace: "large",
          seeds: [`graph/n${index * 37}.md`, `graph/n${index * 37 + 1}.md`],
          maxDepth: 2,
          // A new restart for each call gives a new cache key: every call walks the graph.
          restart: 0.1 + index / 1_000,
        })
      const warm = await call(0)
      expect(warm.isError).not.toBe(true)
      const times: number[] = []
      for (let index = 1; index <= 40; index += 1) {
        const started = performance.now()
        const result = await call(index)
        times.push(performance.now() - started)
        expect(result.isError).not.toBe(true)
        expect(
          (result.structuredContent?.results as unknown[]).length,
        ).toBeGreaterThan(0)
      }
      times.sort((a, b) => a - b)
      const p95 = times[Math.ceil(times.length * 0.95) - 1] as number
      expect(p95).toBeLessThan(300)
    },
  )
})
