import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Pool, PoolClient } from "pg"
import { z } from "zod"

import { lexicalCandidates } from "../domain/workspaces/knowledge-search.js"
import { log } from "../observability/logger.js"
import { quoteIdent } from "./provision-app-role.js"

const SEARCH_INDEX = "workspace_knowledge_chunks_search_idx"

type PlanNode = {
  "Node Type": string
  "Relation Name"?: string
  "Index Name"?: string
  "Index Cond"?: string
  Plans?: PlanNode[]
}

const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Relation Name": z.string().optional(),
    "Index Name": z.string().optional(),
    "Index Cond": z.string().optional(),
    Plans: z.array(planNode).optional(),
  }),
)
const explainJson = z.array(z.object({ Plan: planNode }))

/** Every node of an EXPLAIN (FORMAT JSON) plan. */
function planNodes(plan: unknown): PlanNode[] {
  const nodes: PlanNode[] = []
  const visit = (node: PlanNode) => {
    nodes.push(node)
    for (const child of node.Plans ?? []) visit(child)
  }
  for (const root of explainJson.parse(plan)) visit(root.Plan)
  return nodes
}

/** The index conditions of the full-text index in a plan of the lexical candidates. */
export function searchIndexConditions(plan: unknown): string[] {
  return planNodes(plan)
    .filter((node) => node["Index Name"] === SEARCH_INDEX)
    .map((node) => node["Index Cond"] ?? "")
}

/** An index condition that holds both the org of the transaction and the full-text match. */
export function servesOrgAndMatch(condition: string): boolean {
  return (
    condition.includes("current_setting('app.organization_id'") &&
    condition.includes("@@")
  )
}

type SearchPlan = {
  /** The chunk indexes of the natural plan, or "a full read". */
  natural: string
  /** The GIN index serves the org and the match, with sequential scans off. */
  served: boolean
}

/**
 * The plan of the knowledge search's full-text match for the app role, on the
 * database's own statistics (CTX-1380), and one log line about it. The match
 * reads a view with no condition that a btree index can serve, so its only
 * paths are the GIN index (with the org and the match as its conditions) and
 * a full read, which the planner takes on a small table. Only a GIN index that
 * does not serve both conditions is a warning.
 *
 * EXPLAIN without ANALYZE runs nothing and reads no row. The org id and the
 * terms are fixed, and the transaction rolls back. A failure of the check is a
 * warning too, and gives undefined: it does not stop the deploy.
 */
export async function checkKnowledgeSearchPlan(
  pool: Pool,
  roleName: string,
): Promise<SearchPlan | undefined> {
  const query = new PgDialect().sqlToQuery(
    sql`EXPLAIN (FORMAT JSON) ${lexicalCandidates("migrate plan check", sql`true`)}`,
  )
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    const explain = async (connected: PoolClient) =>
      (
        await connected.query<{ "QUERY PLAN": unknown }>(
          query.sql,
          query.params,
        )
      ).rows[0]?.["QUERY PLAN"]
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE ${quoteIdent(roleName)}`)
    await client.query(
      "SELECT set_config('app.organization_id', 'org_migrate_plan_check', true)",
    )
    const naturalNodes = planNodes(await explain(client))
    const natural = naturalNodes.some(
      (node) =>
        node["Node Type"] === "Seq Scan" &&
        node["Relation Name"] === "workspace_knowledge_chunks",
    )
      ? "a full read"
      : naturalNodes
          .map((node) => node["Index Name"] ?? "")
          .filter((name) => name.startsWith("workspace_knowledge_chunks_"))
          .join(", ")
    await client.query("SET LOCAL enable_seqscan = off")
    const served = searchIndexConditions(await explain(client)).some(
      servesOrgAndMatch,
    )
    const line = {
      step: "migrate",
      message: served
        ? "[migrate] knowledge search plan: the GIN index serves the org and the full-text match"
        : "[migrate] knowledge search plan: the GIN index does not serve the org and the full-text match",
      role: roleName,
      index: SEARCH_INDEX,
      natural,
    }
    if (served) log.info(line)
    else log.warn(line)
    return { natural, served }
  } catch (error) {
    log.warn({
      step: "migrate",
      message: "[migrate] knowledge search plan: the check failed",
      role: roleName,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
}
