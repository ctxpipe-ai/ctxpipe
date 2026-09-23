/**
 * Retrieval evaluation for graph traversal against a real FalkorDB.
 * Requires GRAPH_DB_URI (set in .env.local; `pnpm dev:infra` starts FalkorDB).
 *
 * Each scenario is a question the advisor gets asked, the graph shape that
 * answers it, and the facts a good answer cannot do without.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { FalkorDB } from "falkordb"
import { afterAll, describe, expect, it } from "vitest"
import {
  closeGraphDb,
  getConfig,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { type GraphTraversalOptions, graphTraversal } from "./graphTraversal.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const graphUri = process.env.GRAPH_DB_URI
const ORG_SLUG = "traversal-eval"
const seededOrgIds: string[] = []

type Node = [kind: string, id: string]

type Edge = {
  from: Node
  predicate: string
  to: Node
  confidence: number
  validFrom?: string
  validTo?: string
}

function edge(
  from: Node,
  predicate: string,
  to: Node,
  confidence: number,
  validity: { validFrom?: string; validTo?: string } = {},
): Edge {
  return { from, predicate, to, confidence, ...validity }
}

function claimId(e: Edge): string {
  return `clm_${e.predicate}_${e.from[1]}_${e.to[1]}`
}

/**
 * Edges are created in list order: FalkorDB expands the newest edges first, so
 * order is how a scenario reproduces "the useful fact was written first".
 * Open-ended validity is "" because graphProjection writes it that way.
 */
async function seed(
  name: string,
  edges: Edge[],
  statuses: Record<string, string> = {},
): Promise<string> {
  const orgId = `org_eval_${name}_${Date.now()}`
  seededOrgIds.push(orgId)

  const groups = new Map<string, Edge[]>()
  for (const e of edges) {
    const key = `${e.from[0]}|${e.predicate}|${e.to[0]}`
    const group = groups.get(key)
    if (group) group.push(e)
    else groups.set(key, [e])
  }

  await withGraphClient({ orgId, orgSlug: ORG_SLUG }, async () => {
    const driver = getGraphClient()
    for (const group of groups.values()) {
      const [first] = group
      if (!first) continue
      await driver.executeQuery(
        `UNWIND $rows AS row
         MERGE (s:${first.from[0]} { id: row.from, orgId: $orgId })
         MERGE (o:${first.to[0]} { id: row.to, orgId: $orgId })
         SET s.kind = '${first.from[0]}', s.name = row.from,
             o.kind = '${first.to[0]}', o.name = row.to
         CREATE (s)-[:${first.predicate} {
           claim_id: row.claimId,
           status: 'active',
           aggregate_confidence: row.confidence,
           valid_from: row.validFrom,
           valid_to: row.validTo
         }]->(o)`,
        {
          orgId,
          rows: group.map((e) => ({
            from: e.from[1],
            to: e.to[1],
            claimId: claimId(e),
            confidence: e.confidence,
            validFrom: e.validFrom ?? "",
            validTo: e.validTo ?? "",
          })),
        },
      )
    }
    await driver.executeQuery(
      `UNWIND $rows AS row
       MATCH (n) WHERE n.id = row.id AND n.orgId = $orgId
       SET n.status = row.status`,
      {
        orgId,
        rows: Object.entries(statuses).map(([id, status]) => ({ id, status })),
      },
    )
  })
  return orgId
}

function traverse(
  orgId: string,
  startId: string,
  options: GraphTraversalOptions,
) {
  return graphTraversal(orgId, ORG_SLUG, startId, options)
}

const billing: Node = ["Service", "svc_billing"]
const payments: Node = ["Team", "team_payments"]
const queueAdr: Node = ["Decision", "adr_queue"]

function files(count: number, predicate: string, target: Node): Edge[] {
  return Array.from({ length: count }, (_, i) =>
    edge(["File", `file_${i}`], predicate, target, 0.95),
  )
}

describe.skipIf(!graphUri)("graph traversal evaluation (FalkorDB)", () => {
  afterAll(async () => {
    if (getConfig().provider !== "falkordb") {
      for (const orgId of seededOrgIds) {
        await withGraphClient({ orgId, orgSlug: ORG_SLUG }, () =>
          getGraphClient().executeQuery(
            "MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n",
            { orgId },
          ),
        )
      }
      await closeGraphDb()
      return
    }
    await closeGraphDb()
    const db = await FalkorDB.connect({ url: graphUri })
    for (const orgId of seededOrgIds) {
      await db
        .selectGraph(orgId)
        .delete()
        .catch(() => undefined)
    }
    await db.close()
  })

  it("who owns billing and what shaped it: owner and ADR survive hundreds of file edges", async () => {
    const orgId = await seed("crowding", [
      edge(queueAdr, "INFLUENCES", billing, 0.9),
      edge(payments, "OWNS", billing, 0.95),
      ...files(300, "PART_OF", billing),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 3,
      limit: 20,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(["team_payments", "adr_queue"]),
    )
  })

  it("the same question gets the same facts whichever order they were written in", async () => {
    const facts = [
      edge(queueAdr, "INFLUENCES", billing, 0.9),
      edge(payments, "OWNS", billing, 0.95),
    ]
    const bulk = files(300, "PART_OF", billing)
    const oldestFirst = await seed("order_a", [...facts, ...bulk])
    const newestFirst = await seed("order_b", [...bulk, ...facts])

    const options = { maxDepth: 3, limit: 20 }
    const a = await traverse(oldestFirst, "svc_billing", options)
    const b = await traverse(newestFirst, "svc_billing", options)

    expect([...a.nodeIds].sort()).toEqual([...b.nodeIds].sort())
    expect([...a.edgeClaimIds].sort()).toEqual([...b.edgeClaimIds].sort())
  })

  it("who owns billing now: an ownership that ended is not walked", async () => {
    const orgId = await seed("validity", [
      edge(["Team", "team_old"], "OWNS", billing, 0.95, {
        validFrom: "2024-01-01T00:00:00.000Z",
        validTo: "2025-01-01T00:00:00.000Z",
      }),
      edge(["Team", "team_new"], "OWNS", billing, 0.95, {
        validFrom: "2025-01-01T00:00:00.000Z",
      }),
      edge(queueAdr, "INFLUENCES", billing, 0.9),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 20,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(["team_new", "adr_queue"]),
    )
    expect(result.nodeIds).not.toContain("team_old")
  })

  it("why is billing built this way: the discussion and the superseded ADR survive the ADR's file mentions", async () => {
    const newAdr: Node = ["Decision", "adr_queue_v2"]
    const orgId = await seed("why", [
      edge(["Thread", "thr_queue_debate"], "REFERENCES", newAdr, 0.9),
      edge(newAdr, "SUPERSEDES", queueAdr, 0.9),
      edge(newAdr, "INFLUENCES", billing, 0.9),
      ...Array.from({ length: 100 }, (_, i) =>
        edge(newAdr, "MENTIONS", ["File", `file_${i}`], 0.9),
      ),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 3,
      limit: 20,
      useExtensionLayer: true,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(["thr_queue_debate", "adr_queue"]),
    )
  })

  it("who owns the library billing depends on: a second hop is reached past hundreds of instruction links", async () => {
    const ledger: Node = ["Library", "lib_ledger"]
    const orgId = await seed("two_hop", [
      edge(["Team", "team_ledger"], "OWNS", ledger, 0.95),
      edge(billing, "DEPENDS_ON", ledger, 0.8),
      ...Array.from({ length: 300 }, (_, i) =>
        edge(billing, "HAS_INSTRUCTION", ["InstructionUnit", `iu_${i}`], 0.72),
      ),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 2,
      limit: 20,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(["lib_ledger", "team_ledger"]),
    )
  })

  it("a small service keeps every direct fact when there is nothing deeper", async () => {
    const direct = Array.from({ length: 15 }, (_, i) =>
      edge(billing, "DEPENDS_ON", ["Library", `lib_${i}`], 0.8),
    )
    const orgId = await seed("small", direct)

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 3,
      limit: 20,
    })

    expect(result.edgeClaimIds).toHaveLength(15)
  })

  it("what is the standard for billing's queue: the accepted ADR wins over proposed and superseded ones, and the model can read which is which", async () => {
    const orgId = await seed(
      "adr_status",
      [
        edge(["Decision", "adr_kafka"], "INFLUENCES", billing, 0.9),
        edge(["Decision", "adr_rabbit"], "INFLUENCES", billing, 0.9),
        edge(["Decision", "adr_sqs"], "INFLUENCES", billing, 0.9),
        ...Array.from({ length: 50 }, (_, i) =>
          edge(
            billing,
            "HAS_INSTRUCTION",
            ["InstructionUnit", `iu_${i}`],
            0.72,
          ),
        ),
      ],
      { adr_kafka: "proposed", adr_rabbit: "superseded", adr_sqs: "accepted" },
    )

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 4,
    })

    expect(result.nodeIds).toContain("adr_sqs")
    expect(result.nodeIds).not.toContain("adr_rabbit")
    expect(result.nodes).toContainEqual({
      id: "adr_sqs",
      kind: "Decision",
      name: "adr_sqs",
      status: "accepted",
    })
  })

  it("what does billing depend on: better-evidenced facts win the limited slots", async () => {
    const strong = Array.from({ length: 5 }, (_, i) =>
      edge(billing, "DEPENDS_ON", ["Library", `lib_strong_${i}`], 0.95),
    )
    const weak = Array.from({ length: 25 }, (_, i) =>
      edge(billing, "DEPENDS_ON", ["Library", `lib_weak_${i}`], 0.6),
    )
    const orgId = await seed("trust", [...strong, ...weak])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 5,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(strong.map((e) => e.to[1])),
    )
    expect(result.nodeIds.filter((id) => id.startsWith("lib_weak_"))).toEqual(
      [],
    )
  })
})
