/**
 * Retrieval eval for the advisor's graph walk on a synthetic engineering org
 * (`test/engineeringOrgGraph.ts`). Gold answers come from direct graph queries:
 * the owners of a service, the ADRs scoped to it, the newest pull requests that
 * changed it, and what it depends on. For each question intent, the walk must
 * keep recall of the top five gold answers at or above a committed floor.
 * Requires GRAPH_DB_URI (CI starts FalkorDB; locally `pnpm dev:infra`).
 */
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { FalkorDB } from "falkordb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { engineeringOrgFixture } from "../../../test/engineeringOrgGraph.js"
import {
  closeGraphDb,
  getConfig,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { ensureNodeIdIndexes } from "../../platform/graph/indexes.js"
import { type GraphTraversalOptions, graphTraversal } from "./graphTraversal.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

const graphUri = process.env.GRAPH_DB_URI
const ORG_SLUG = "retrieval-eval"
const orgId = `org_eval_retrieval_${Date.now()}`

type Intent = "ownership" | "why" | "change" | "structure"
type Question = {
  intent: Intent
  startId: string
  query: string
  extension: boolean
  /** Ordered by importance; recall counts the first five. */
  gold: string[]
}

async function seedFixture(): Promise<void> {
  const { nodes, edges } = engineeringOrgFixture()
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]))
  await withGraphClient({ orgId, orgSlug: ORG_SLUG }, async () => {
    const driver = getGraphClient()
    const kinds = [...new Set(nodes.map((n) => n.kind))]
    await ensureNodeIdIndexes(orgId, kinds)
    for (const kind of kinds) {
      const rows = nodes.filter((n) => n.kind === kind)
      for (let i = 0; i < rows.length; i += 500) {
        await driver.executeQuery(
          `UNWIND $rows AS row
           CREATE (:${kind} { id: row.id, orgId: $orgId, kind: '${kind}', name: row.name,
             status: row.status, summary: row.summary, review_decision: row.review })`,
          {
            orgId,
            rows: rows.slice(i, i + 500).map((n) => ({
              id: n.id,
              name: n.name,
              status: n.status ?? "",
              summary: n.summary ?? "",
              review: n.review_decision ?? "",
            })),
          },
        )
      }
    }
    const groups = new Map<string, typeof edges>()
    for (const e of edges) {
      const key = `${kindOf.get(e.from)}|${e.type}|${kindOf.get(e.to)}`
      groups.set(key, [...(groups.get(key) ?? []), e])
    }
    let claim = 0
    for (const [key, group] of groups) {
      const [fromKind, type, toKind] = key.split("|")
      for (let i = 0; i < group.length; i += 500) {
        await driver.executeQuery(
          `UNWIND $rows AS row
           MATCH (s:${fromKind} { id: row.from }) MATCH (o:${toKind} { id: row.to })
           CREATE (s)-[:${type} { claim_id: row.claimId, status: 'active',
             aggregate_confidence: row.confidence, source_count: row.sources,
             valid_from: row.validFrom, valid_to: '' }]->(o)`,
          {
            rows: group.slice(i, i + 500).map((e) => ({
              from: e.from,
              to: e.to,
              claimId: `clm_fx_${(claim++).toString(36).padStart(6, "0")}`,
              confidence: e.confidence,
              sources: e.sourceCount ?? 1,
              validFrom: e.validFrom ?? "",
            })),
          },
        )
      }
    }
  })
}

async function goldQuestions(): Promise<Question[]> {
  return withGraphClient({ orgId, orgSlug: ORG_SLUG }, async () => {
    const driver = getGraphClient()
    const ids = async (cypher: string, params: Record<string, unknown>) =>
      (await driver.executeQuery(cypher, { orgId, ...params })).records.map(
        (r) => String(r.get("id")),
      )
    const services = (
      await driver.executeQuery(
        "MATCH (s:Service) WHERE s.orgId = $orgId AND s.name <> './' RETURN s.id AS id, s.name AS name",
        { orgId },
      )
    ).records.map((r) => ({
      id: String(r.get("id")),
      name: String(r.get("name")),
    }))

    const questions: Question[] = []
    for (const { id, name } of services) {
      const add = (
        intent: Intent,
        query: string,
        extension: boolean,
        gold: string[],
      ) => {
        if (gold.length > 0)
          questions.push({ intent, startId: id, query, extension, gold })
      }
      add(
        "ownership",
        `Who owns ${name}?`,
        true,
        await ids(
          "MATCH (t)-[:OWNS]->(s:Service { id: $id }) RETURN DISTINCT t.id AS id",
          { id },
        ),
      )
      add(
        "why",
        `Why is ${name} built this way? Which decisions shape it?`,
        true,
        await ids(
          `MATCH (d:Decision)-[r:INFLUENCES]->(s:Service { id: $id })
           WHERE r.aggregate_confidence >= 0.8
           RETURN d.id AS id, r.aggregate_confidence AS c ORDER BY c DESC, id`,
          { id },
        ),
      )
      add(
        "change",
        `What changed recently in ${name}? Is there prior work?`,
        true,
        await ids(
          `MATCH (p:PullRequest)-[c]->(:File)-[:PART_OF]->(s:Service { id: $id })
           WHERE type(c) IN ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']
           RETURN p.id AS id, max(c.valid_from) AS at ORDER BY at DESC, id LIMIT 5`,
          { id },
        ),
      )
      add(
        "structure",
        `What does ${name} depend on?`,
        false,
        await ids(
          `MATCH (s:Service { id: $id })-[r]->(x)
           WHERE type(r) IN ['DEPENDS_ON', 'USES_LIBRARY', 'CONSUMES_API', 'READS_FROM', 'WRITES_TO', 'RUNS_ON']
           RETURN DISTINCT x.id AS id ORDER BY id`,
          { id },
        ),
      )
    }
    return questions
  })
}

async function recallByIntent(
  questions: Question[],
  options: Partial<GraphTraversalOptions> = {},
): Promise<Record<Intent, number>> {
  const sums = {
    ownership: [0, 0],
    why: [0, 0],
    change: [0, 0],
    structure: [0, 0],
  }
  for (const question of questions) {
    const result = await graphTraversal(orgId, ORG_SLUG, question.startId, {
      maxDepth: 3,
      limit: 20,
      useExtensionLayer: question.extension,
      query: question.query,
      ...options,
    })
    const reached = new Set(result.nodeIds)
    const top = question.gold.slice(0, 5)
    const sum = sums[question.intent] as number[]
    sum[0] =
      (sum[0] ?? 0) + top.filter((g) => reached.has(g)).length / top.length
    sum[1] = (sum[1] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(sums).map(([intent, [total = 0, count = 0]]) => [
      intent,
      count > 0 ? total / count : 0,
    ]),
  ) as Record<Intent, number>
}

describe.skipIf(!graphUri)(
  "graph retrieval eval (synthetic engineering org)",
  () => {
    let questions: Question[] = []

    beforeAll(async () => {
      await seedFixture()
      questions = await goldQuestions()
    }, 120_000)

    afterAll(async () => {
      if (getConfig().provider !== "falkordb") {
        await withGraphClient({ orgId, orgSlug: ORG_SLUG }, () =>
          getGraphClient().executeQuery(
            "MATCH (n) WHERE n.orgId = $orgId DETACH DELETE n",
            {
              orgId,
            },
          ),
        )
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

    it("keeps recall of the top gold answers at or above the floor for each intent", async () => {
      const withSignals = await recallByIntent(questions)
      const withoutIntent = await recallByIntent(questions, {
        intent: "general",
      })

      const row = (label: string, r: Record<Intent, number>) =>
        `| ${label} | ${r.ownership.toFixed(2)} | ${r.why.toFixed(2)} | ${r.change.toFixed(2)} | ${r.structure.toFixed(2)} |`
      const report = [
        `### Graph retrieval eval (${questions.length} questions)`,
        "",
        "| walk | ownership | why | change | structure |",
        "|---|---|---|---|---|",
        row("signals", withSignals),
        row("signals, intent off", withoutIntent),
        "",
      ].join("\n")
      process.stdout.write(`${report}\n`)
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)

      expect(questions.length).toBeGreaterThanOrEqual(20)
      expect(withSignals.ownership).toBeGreaterThanOrEqual(1)
      expect(withSignals.why).toBeGreaterThanOrEqual(0.95)
      expect(withSignals.change).toBeGreaterThanOrEqual(0.85)
      expect(withSignals.structure).toBeGreaterThanOrEqual(0.95)
    }, 120_000)
  },
)
