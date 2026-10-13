/**
 * Retraction and node deletion against a live graph engine: exactly the
 * named edges and nodes go, everything else stays.
 * Requires GRAPH_DB_URI (set in .env.local; `pnpm dev:infra` starts FalkorDB).
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { FalkorDB } from "falkordb"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const orgId = `org_eval_retraction_${Date.now()}`
const orgSlug = "traversal-eval"

vi.mock("../../auth/context.js", () => ({
  requireCurrentOrgId: () => orgId,
  requireCurrentOrgSlug: () => orgSlug,
}))

import {
  closeGraphDb,
  getConfig,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import {
  deleteObjectsFromGraph,
  retractClaimsFromGraph,
} from "./graphProjection.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const graphUri = process.env.GRAPH_DB_URI

function run(query: string) {
  return withGraphClient({ orgId, orgSlug }, () =>
    getGraphClient().executeQuery(query, { orgId }),
  )
}

async function remaining() {
  const nodes = await run(
    "MATCH (n) WHERE n.orgId = $orgId RETURN n.id AS id ORDER BY id",
  )
  const edges = await run(
    "MATCH (s)-[r]->(o) WHERE s.orgId = $orgId RETURN r.claim_id AS id ORDER BY id",
  )
  return {
    nodes: nodes.records.map((r) => r.get("id")),
    claims: edges.records.map((r) => r.get("id")),
  }
}

describe.skipIf(!graphUri)("graph retraction (live graph engine)", () => {
  beforeEach(async () => {
    await run("MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n")
    await run(
      `CREATE (a:Service { id: 'svc', orgId: $orgId }),
              (b:Library { id: 'lib_1', orgId: $orgId }),
              (c:Library { id: 'lib_2', orgId: $orgId }),
              (t:Team { id: 'team', orgId: $orgId }),
              (a)-[:DEPENDS_ON { claim_id: 'c1' }]->(b),
              (a)-[:DEPENDS_ON { claim_id: 'c2' }]->(c),
              (t)-[:OWNS { claim_id: 'c3' }]->(a)`,
    )
  })

  afterAll(async () => {
    if (getConfig().provider !== "falkordb") {
      await run("MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n")
      await closeGraphDb()
      return
    }
    await closeGraphDb()
    const db = await FalkorDB.connect({ url: graphUri })
    await db
      .selectGraph(orgId)
      .delete()
      .catch(() => undefined)
    await db.close()
  })

  it("retracts exactly the named claim edges", async () => {
    await retractClaimsFromGraph(["c1", "c3"])

    expect(await remaining()).toEqual({
      nodes: ["lib_1", "lib_2", "svc", "team"],
      claims: ["c2"],
    })
  })

  it("deletes exactly the named nodes and their edges", async () => {
    await deleteObjectsFromGraph(["lib_1", "team"])

    expect(await remaining()).toEqual({
      nodes: ["lib_2", "svc"],
      claims: ["c2"],
    })
  })
})
