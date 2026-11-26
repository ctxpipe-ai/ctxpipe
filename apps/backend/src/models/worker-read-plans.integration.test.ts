import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, inArray, type SQL, sql } from "drizzle-orm"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"
import { workspaceWriteJobs } from "../db/schema/workspaces.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { analyzeAsOwner } from "../test/analyze-as-owner.js"
import { failJobsWithEndedRun } from "./workspace-write-jobs.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_read_plans_${suffix}`
const workspaceId = `ws_test_read_plans_${suffix}`

type PlanNode = {
  "Node Type": string
  "Relation Name"?: string
  "Index Name"?: string
  Plans?: PlanNode[]
}

const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Relation Name": z.string().optional(),
    "Index Name": z.string().optional(),
    Plans: z.array(planNode).optional(),
  }),
)

/** Every node of an EXPLAIN (FORMAT JSON) plan. */
function planNodes(plan: unknown): PlanNode[] {
  const nodes: PlanNode[] = []
  const visit = (node: PlanNode) => {
    nodes.push(node)
    for (const child of node.Plans ?? []) visit(child)
  }
  for (const root of z.array(z.object({ Plan: planNode })).parse(plan))
    visit(root.Plan)
  return nodes
}

/** Each scan of `relation` in a JSON plan, with its node type and index. */
function scansOf(plan: unknown, relation: string) {
  return planNodes(plan)
    .filter((node) => node["Relation Name"] === relation)
    .map((node) => ({ type: node["Node Type"], index: node["Index Name"] }))
}

/**
 * The plan as the app role, under row-level security, with sequential
 * scans off: a scan stays sequential only when no index can serve it.
 */
async function explain(query: () => SQL) {
  return withOrgDbContext(orgId, async (db) => {
    await db.execute(sql`SET LOCAL ROLE ctxpipe_app`)
    await db.execute(sql`SET LOCAL enable_seqscan = off`)
    const explained = await db.execute<{ "QUERY PLAN": unknown }>(
      sql`EXPLAIN (FORMAT JSON) ${query()}`,
    )
    return explained.rows[0]?.["QUERY PLAN"]
  })
}

describe("index plans of the worker's frequent reads (CTX-1708)", () => {
  let owner: pg.Client

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
    owner = new pg.Client({
      connectionString: ownerUrlForMigrate(connectionString),
    })
    await owner.connect()
  })

  afterAll(async () => {
    await owner.query("DELETE FROM workspaces WHERE id = $1", [workspaceId])
    await owner.query(
      "DELETE FROM openworkflow.workflow_runs WHERE namespace_id = $1 AND id LIKE $2",
      [openWorkflowNamespaceId(), `run_read_plans_${suffix}_%`],
    )
    await owner.end()
    await closeDb()
  })

  it("finds the owning run of a write job by its id or its idempotency key, not by a scan of every run", async () => {
    // Runs of many write jobs, with statistics, as in production. A job need
    // not exist: the plan does not depend on it.
    await owner.query(
      `INSERT INTO openworkflow.workflow_runs
         (namespace_id, id, workflow_name, status, idempotency_key, config, input, attempts, created_at, updated_at)
       SELECT $1, $2 || g, 'workspace-write-' || (array['connector-mirror', 'semantic-merge', 'ui-file-edit'])[1 + g % 3],
         (array['completed', 'failed'])[1 + g % 2], 'wjob_' || $2 || g, '{}',
         jsonb_build_object('orgId', $3::text, 'workspaceId', 'ws_' || g % 7, 'jobId', 'wjob_' || $2 || g), 1, now(), now()
       FROM generate_series(1, 3000) g`,
      [openWorkflowNamespaceId(), `run_read_plans_${suffix}_`, orgId],
    )
    await analyzeAsOwner(connectionString ?? "", ["openworkflow.workflow_runs"])
    const plan = await explain(() =>
      failJobsWithEndedRun(
        eq(workspaceWriteJobs.id, `wjob_${suffix}`),
        inArray(workspaceWriteJobs.status, ["queued", "running", "paused"]),
      ).getSQL(),
    )
    const scans = scansOf(plan, "workflow_runs")
    // The owner in the new payload and in the condition, each by id and by
    // idempotency key, and the status of the owner by its id.
    expect(scans.length).toBeGreaterThanOrEqual(5)
    for (const scan of scans)
      expect(scan).toEqual({
        type: "Index Scan",
        index: expect.toBeOneOf([
          "workflow_runs_pkey",
          "workflow_runs_workflow_name_idempotency_key_created_at_idx",
        ]),
      })
  })
})
