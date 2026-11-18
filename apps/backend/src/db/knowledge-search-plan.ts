import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Pool } from "pg"

import { lexicalCandidates } from "../domain/workspaces/knowledge-search.js"
import { log } from "../observability/logger.js"
import { quoteIdent } from "./provision-app-role.js"

const SEARCH_INDEX = "workspace_knowledge_chunks_search_idx"

/** Every node of an EXPLAIN (FORMAT JSON) plan. */
export function planNodes(plan: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  const visit = (node: Record<string, unknown>) => {
    nodes.push(node)
    for (const child of (node.Plans as Record<string, unknown>[]) ?? []) {
      visit(child)
    }
  }
  for (const root of (plan as { Plan: Record<string, unknown> }[]) ?? []) {
    visit(root.Plan)
  }
  return nodes
}

/** The index conditions of the full-text index in a plan of the lexical candidates. */
export function searchIndexConditions(plan: unknown): string[] {
  return planNodes(plan)
    .filter((node) => node["Index Name"] === SEARCH_INDEX)
    .map((node) => String(node["Index Cond"]))
}

/**
 * Logs one line about the plan of the knowledge search's full-text match for
 * the app role, on the database's own statistics (CTX-1380). The match reads
 * a view with no condition that a btree index can serve, so its only paths
 * are the GIN index (with the org and the match as its conditions) and a
 * full read, which the planner takes on a small table. The line gives the
 * natural plan's scan of the chunks, and whether the GIN index serves both
 * conditions with sequential scans off. Only a no is a warning.
 *
 * EXPLAIN without ANALYZE runs nothing and reads no row. The org id and the
 * terms are fixed, and the transaction rolls back. A failure of the check is a
 * warning too: it does not stop the deploy.
 */
export async function logKnowledgeSearchPlan(
  pool: Pool,
  roleName: string,
): Promise<void> {
  const query = new PgDialect().sqlToQuery(
    sql`EXPLAIN (FORMAT JSON) ${lexicalCandidates("migrate plan check", sql`true`)}`,
  )
  const client = await pool.connect()
  const explain = async () =>
    (await client.query<{ "QUERY PLAN": unknown }>(query.sql, query.params))
      .rows[0]?.["QUERY PLAN"]
  try {
    await client.query("BEGIN")
    await client.query(`SET LOCAL ROLE ${quoteIdent(roleName)}`)
    await client.query(
      "SELECT set_config('app.organization_id', 'org_migrate_plan_check', true)",
    )
    const naturalNodes = planNodes(await explain())
    const natural = naturalNodes.some(
      (node) =>
        node["Node Type"] === "Seq Scan" &&
        node["Relation Name"] === "workspace_knowledge_chunks",
    )
      ? "a full read"
      : naturalNodes
          .map((node) => String(node["Index Name"] ?? ""))
          .filter((name) => name.startsWith("workspace_knowledge_chunks_"))
          .join(", ")
    await client.query("SET LOCAL enable_seqscan = off")
    const served = searchIndexConditions(await explain()).some(
      (condition) =>
        condition.includes("current_setting('app.organization_id'") &&
        condition.includes("@@"),
    )
    const line = {
      step: "migrate",
      message: `[migrate] knowledge search plan as ${roleName}: the chunks through ${natural}; ${SEARCH_INDEX} ${served ? "serves" : "does not serve"} the org and the full-text match`,
    }
    if (served) log.info(line)
    else log.warn(line)
  } catch (error) {
    log.warn({
      step: "migrate",
      message: `[migrate] knowledge search plan: the check failed: ${String(error)}`,
    })
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}
