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
  /** Evidence rows behind the claim (`source_count`), default 1 */
  sources?: number
}

function edge(
  from: Node,
  predicate: string,
  to: Node,
  confidence: number,
  more: { validFrom?: string; validTo?: string; sources?: number } = {},
): Edge {
  return { from, predicate, to, confidence, ...more }
}

/** The day that the recency scenarios measure from. */
const asOf = new Date("2026-10-05T00:00:00.000Z")
const daysAgo = (days: number) =>
  new Date(asOf.getTime() - days * 86_400_000).toISOString()

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
  summaries: Record<string, string> = {},
  /** Other node properties by node id, for example `review_decision` */
  props: Record<string, Record<string, string>> = {},
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
           source_count: row.sources,
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
            sources: e.sources ?? 1,
            validFrom: e.validFrom ?? "",
            validTo: e.validTo ?? "",
          })),
        },
      )
    }
    const keys = new Set(Object.values(props).flatMap((p) => Object.keys(p)))
    for (const key of keys) {
      await driver.executeQuery(
        `UNWIND $rows AS row
         MATCH (n) WHERE n.id = row.id AND n.orgId = $orgId
         SET n.${key} = row.value`,
        {
          orgId,
          rows: Object.entries(props).flatMap(([id, values]) =>
            values[key] === undefined ? [] : [{ id, value: values[key] }],
          ),
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
    await driver.executeQuery(
      `UNWIND $rows AS row
       MATCH (n) WHERE n.id = row.id AND n.orgId = $orgId
       SET n.summary = row.summary`,
      {
        orgId,
        rows: Object.entries(summaries).map(([id, summary]) => ({
          id,
          summary,
        })),
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
      edge(["Team", "team_ends_today"], "OWNS", billing, 0.95, {
        validFrom: "2025-01-01T00:00:00.000Z",
        validTo: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
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
    expect(result.nodeIds).not.toContain("team_ends_today")
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
      summary: null,
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

  it("why does billing use a queue: the why-walk reaches the pull request that added the ADR, which tells why and what was ruled out", async () => {
    const adrFile: Node = ["File", "file_adr_queue"]
    const addingPr: Node = ["PullRequest", "pr_adr_queue"]
    const orgId = await seed(
      "why_pr",
      [
        edge(addingPr, "ADDED", adrFile, 0.95, {
          validFrom: "2025-03-04T00:00:00.000Z",
        }),
        edge(addingPr, "TARGETS", ["Repository", "repo_billing"], 0.95, {
          validFrom: "2025-03-04T00:00:00.000Z",
        }),
        ...Array.from({ length: 100 }, (_, i) =>
          edge(
            ["PullRequest", `pr_other_${i}`],
            "MODIFIED",
            ["File", `file_${i}`],
            0.95,
            { validFrom: "2026-01-01T00:00:00.000Z" },
          ),
        ),
        ...Array.from({ length: 100 }, (_, i) =>
          edge(queueAdr, "MENTIONS", ["File", `file_${i}`], 0.9),
        ),
        edge(queueAdr, "DECLARED_IN", adrFile, 0.95),
        edge(queueAdr, "INFLUENCES", billing, 0.9),
        edge(payments, "OWNS", billing, 0.95),
      ],
      {},
      { pr_adr_queue: "Use a queue for billing events (ADR-007)" },
    )

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 3,
      limit: 20,
      useExtensionLayer: true,
    })

    expect(result.nodeIds).toEqual(
      expect.arrayContaining(["adr_queue", "file_adr_queue", "pr_adr_queue"]),
    )
    expect(result.nodes).toContainEqual({
      id: "pr_adr_queue",
      kind: "PullRequest",
      name: "pr_adr_queue",
      status: null,
      summary: "Use a queue for billing events (ADR-007)",
    })
  })

  it("what changed in billing lately: the newest pull requests win when many have the same confidence", async () => {
    const repo: Node = ["Repository", "repo_billing"]
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
    // Claim id order (pr_00 first) is the opposite of merge order, and the
    // pull requests are written in neither order.
    const pulls = Array.from({ length: 50 }, (_, i) =>
      edge(
        ["PullRequest", `pr_${String(i).padStart(2, "0")}`],
        "TARGETS",
        repo,
        0.95,
        {
          validFrom: day(i),
        },
      ),
    )
    const orgId = await seed("newest", [
      ...pulls.filter((_, i) => i % 2 === 1),
      ...pulls.filter((_, i) => i % 2 === 0),
    ])

    for (const useExtensionLayer of [false, true]) {
      const result = await traverse(orgId, "repo_billing", {
        maxDepth: 1,
        limit: 5,
        useExtensionLayer,
      })

      expect([...result.nodeIds].sort()).toEqual([
        "pr_45",
        "pr_46",
        "pr_47",
        "pr_48",
        "pr_49",
        "repo_billing",
      ])
    }
  })

  it("what are billing's rules for retries: the instructions the search found win over hundreds with the same confidence", async () => {
    const orgId = await seed(
      "prefer",
      Array.from({ length: 300 }, (_, i) =>
        edge(billing, "HAS_INSTRUCTION", ["InstructionUnit", `iu_${i}`], 0.72),
      ),
    )

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 5,
      searchHits: [
        { id: "iu_217", score: 0.03 },
        { id: "iu_42", score: 0.02 },
        { id: "obj_not_in_graph", score: 0.01 },
      ],
    })

    expect(result.nodeIds).toEqual(expect.arrayContaining(["iu_217", "iu_42"]))
    expect(result.edgeClaimIds).toHaveLength(5)
  })

  it("what does billing depend on: facts that two sources agree on win over single-source facts with more confidence", async () => {
    const corroborated = Array.from({ length: 5 }, (_, i) =>
      edge(billing, "DEPENDS_ON", ["Library", `lib_agreed_${i}`], 0.8, {
        sources: 2,
      }),
    )
    const single = Array.from({ length: 25 }, (_, i) =>
      edge(billing, "DEPENDS_ON", ["Library", `lib_single_${i}`], 0.9),
    )
    const orgId = await seed("corroborated", [...single, ...corroborated])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 5,
      query: "What does billing depend on?",
    })

    expect([...result.nodeIds].sort()).toEqual([
      ...corroborated.map((e) => e.to[1]),
      "svc_billing",
    ])
  })

  it("what did the retry pull request change: its own files win over files that every pull request touches", async () => {
    const pr: Node = ["PullRequest", "pr_retry"]
    const hubs = ["changelog", "ci", "lockfile", "package_json", "tsconfig"]
    const merged = { validFrom: daysAgo(10) }
    const orgId = await seed("hub", [
      ...hubs.flatMap((hub) =>
        Array.from({ length: 100 }, (_, i) =>
          edge(
            ["PullRequest", `pr_history_${i}`],
            "MODIFIED",
            ["File", `file_${hub}`],
            0.95,
            { validFrom: daysAgo(20 + i) },
          ),
        ),
      ),
      ...hubs.map((hub) =>
        edge(pr, "MODIFIED", ["File", `file_${hub}`], 0.95, merged),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        edge(pr, "MODIFIED", ["File", `file_retry_${i}`], 0.95, merged),
      ),
    ])

    const result = await traverse(orgId, "pr_retry", {
      maxDepth: 1,
      limit: 5,
    })

    expect([...result.nodeIds].sort()).toEqual([
      "file_retry_0",
      "file_retry_1",
      "file_retry_2",
      "file_retry_3",
      "file_retry_4",
      "pr_retry",
    ])
  })

  it("who owns billing: every owning team comes first when files, instructions and dependencies are plentiful", async () => {
    const teams = ["team_payments", "team_platform", "team_sre"]
    const orgId = await seed("owners", [
      ...files(300, "PART_OF", billing),
      ...teams.map((team) => edge(["Team", team], "OWNS", billing, 0.95)),
      ...Array.from({ length: 50 }, (_, i) =>
        edge(billing, "HAS_INSTRUCTION", ["InstructionUnit", `iu_${i}`], 0.72),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        edge(["Decision", `adr_${i}`], "INFLUENCES", billing, 0.9),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        edge(billing, "DEPENDS_ON", ["Library", `lib_${i}`], 0.8),
      ),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 1,
      limit: 5,
      query: "Who owns billing?",
    })

    expect(result.nodeIds).toEqual(expect.arrayContaining(teams))
  })

  it("what work was done on the retry issue lately: the newest pull requests that reference it win over two-year-old ones", async () => {
    const issue: Node = ["Issue", "iss_retry"]
    // pr_00 merged 750 days ago and pr_29 25 days ago, so claim id order is
    // oldest first. The reference edges carry no valid_from: the walk reads
    // the merge date from the pull request.
    const ids = Array.from(
      { length: 30 },
      (_, i) => `pr_${String(i).padStart(2, "0")}`,
    )
    const orgId = await seed(
      "recent_prs",
      ids
        .filter((_, i) => i % 3 !== 0)
        .concat(ids.filter((_, i) => i % 3 === 0))
        .map((id) => edge(["PullRequest", id], "REFERENCES", issue, 0.9)),
      {},
      {},
      Object.fromEntries(
        ids.map((id, i) => [id, { merged_at: daysAgo((30 - i) * 25) }]),
      ),
    )

    const result = await traverse(orgId, "iss_retry", {
      maxDepth: 1,
      limit: 5,
      validAt: asOf,
      query: "What work was done on the retry issue recently?",
    })

    expect([...result.nodeIds].sort()).toEqual([
      "iss_retry",
      "pr_25",
      "pr_26",
      "pr_27",
      "pr_28",
      "pr_29",
    ])
  })

  it("what changed the ledger: an approved pull request wins over one merged with changes requested", async () => {
    const ledger: Node = ["File", "file_ledger"]
    const merged = { validFrom: daysAgo(30) }
    const orgId = await seed(
      "review",
      [
        edge(
          ["PullRequest", "pr_a_disputed"],
          "MODIFIED",
          ledger,
          0.95,
          merged,
        ),
        edge(
          ["PullRequest", "pr_b_unreviewed"],
          "MODIFIED",
          ledger,
          0.95,
          merged,
        ),
        edge(
          ["PullRequest", "pr_c_approved"],
          "MODIFIED",
          ledger,
          0.95,
          merged,
        ),
      ],
      {},
      {},
      {
        pr_a_disputed: { review_decision: "CHANGES_REQUESTED" },
        pr_c_approved: { review_decision: "APPROVED" },
      },
    )

    const result = await traverse(orgId, "file_ledger", {
      maxDepth: 1,
      limit: 2,
      validAt: asOf,
    })

    expect([...result.nodeIds].sort()).toEqual([
      "file_ledger",
      "pr_b_unreviewed",
      "pr_c_approved",
    ])
  })

  it("what changed recently in billing: the newest pull requests through CHANGED win over 900 files", async () => {
    // 400 pull requests over two years, one every 1.8 days, written in no
    // order of merge date.
    const pulls = Array.from({ length: 400 }, (_, i) =>
      edge(
        ["PullRequest", `pr_${String(i).padStart(3, "0")}`],
        "CHANGED",
        billing,
        0.95,
        {
          validFrom: daysAgo(1 + i * 1.8),
        },
      ),
    )
    const orgId = await seed("changed", [
      ...files(900, "PART_OF", billing),
      ...pulls.filter((_, i) => i % 2 === 1),
      ...pulls.filter((_, i) => i % 2 === 0),
      edge(payments, "OWNS", billing, 0.95),
    ])

    for (const useExtensionLayer of [false, true]) {
      const result = await traverse(orgId, "svc_billing", {
        maxDepth: 3,
        limit: 20,
        useExtensionLayer,
        validAt: asOf,
        query: "What changed recently in billing?",
      })

      // The ten newest, and no pull request older than the newest twenty.
      const newest = pulls.slice(0, 10).map((e) => e.from[1])
      expect(result.nodeIds).toEqual(expect.arrayContaining(newest))
      const reachedPulls = result.nodeIds.filter((id) => id.startsWith("pr_"))
      expect(reachedPulls.every((id) => Number(id.slice(3)) < 20)).toBe(true)
    }
  })

  it("why is billing built this way: its decisions come before the many pull requests that changed it", async () => {
    const decisions = Array.from({ length: 6 }, (_, i) => `adr_${i}`)
    const orgId = await seed("why_intent", [
      ...decisions.map((id, i) =>
        edge(["Decision", id], "INFLUENCES", billing, i < 2 ? 0.8 : 0.6),
      ),
      ...decisions.map((id) =>
        edge(["Decision", id], "DECLARED_IN", ["File", `file_${id}`], 0.95),
      ),
      ...decisions.flatMap((id) =>
        Array.from({ length: 20 }, (_, i) =>
          edge(["Decision", id], "MENTIONS", ["File", `file_${id}_${i}`], 0.9),
        ),
      ),
      ...Array.from({ length: 200 }, (_, i) =>
        edge(["PullRequest", `pr_${i}`], "CHANGED", billing, 0.95, {
          validFrom: daysAgo(1 + i),
        }),
      ),
      edge(payments, "OWNS", billing, 0.95),
    ])

    const result = await traverse(orgId, "svc_billing", {
      maxDepth: 3,
      limit: 20,
      useExtensionLayer: true,
      validAt: asOf,
      query: "Why is billing built this way?",
    })

    expect(result.nodeIds).toEqual(expect.arrayContaining(decisions))
  })
})
