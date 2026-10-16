import { sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { generateObjectId } from "../../lib/id.js"
import { closeOpenWorkflowClient } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { defineWorkspaceUpgradeReingestRepository } from "../../openworkflow/workflows/workspace-upgrade-reingest.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { ingestionRunState, reingestSlotTurn } from "./reingest.js"

/*
 * The re-ingestion throttle and the step budget of a long run, with real
 * Postgres and real OpenWorkflow runs. This file has its own OpenWorkflow
 * namespace, so it sees no run of another test file. No worker implements
 * ingestion v2 here, so each ingestion v2 run stays `pending`.
 */

vi.hoisted(() => {
  process.env.OPENWORKFLOW_NAMESPACE_ID = `test-reingest-${Math.random().toString(36).slice(2, 10)}`
})

let backend: BackendPostgres
let runner: OpenWorkflow
const upgradeSpec = {
  name: "workspace-upgrade-reingest",
  schema: z.object({ orgId: z.string() }).passthrough(),
}
const queued: string[] = []

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required for this test")
  initDb(databaseUrl)
  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  runner = new OpenWorkflow({ backend })
})

afterAll(async () => {
  for (const id of queued)
    await runner.cancelWorkflowRun(id).catch(() => undefined)
  await backend?.stop()
  await closeOpenWorkflowClient()
  await closeDb()
})

/** Queue an upgrade run that no worker claims: it stays active. */
async function upgradeRun(orgId: string): Promise<string> {
  const handle = await runner.runWorkflow(upgradeSpec, { orgId })
  queued.push(handle.workflowRun.id)
  return handle.workflowRun.id
}

describe("re-ingestion throttle", () => {
  it("gives the slot of an org to its first upgrade run until that run ends, and caps the runs of the instance", async () => {
    const [orgA, orgB, orgC] = [
      generateObjectId("org"),
      generateObjectId("org"),
      generateObjectId("org"),
    ]
    const first = await upgradeRun(orgA)
    const second = await upgradeRun(orgA)
    const other = await upgradeRun(orgB)
    const third = await upgradeRun(orgC)
    const turn = (orgId: string, upgradeRunId: string, runsPerInstance = 4) =>
      reingestSlotTurn({ orgId, upgradeRunId, runsPerInstance })

    expect(await turn(orgA, first)).toEqual({ turn: true })
    // The slot stays with the first run, also between its repositories.
    expect(await turn(orgA, second)).toEqual({
      wait: "A re-ingestion of another Workspace of this organization runs.",
    })
    // Another org is not held by this org.
    expect(await turn(orgB, other)).toEqual({ turn: true })
    // Two heads are before the third org.
    expect(await turn(orgC, third, 2)).toEqual({
      wait: "The re-ingestion slots of this instance are full.",
    })

    await runner.cancelWorkflowRun(first)
    expect(await turn(orgA, second)).toEqual({ turn: true })
    expect(await turn(orgC, third, 2)).toEqual({
      wait: "The re-ingestion slots of this instance are full.",
    })
    await runner.cancelWorkflowRun(other)
    expect(await turn(orgC, third, 2)).toEqual({ turn: true })
  })
})

describe("step budget", () => {
  it(
    "ends a repository run that waits for a long ingestion run inside its step budget",
    { timeout: 90_000 },
    async () => {
      const stepBudget = 12
      const repository = defineWorkspaceUpgradeReingestRepository({
        stepBudget,
        throttle: { firstPollSeconds: 1, maxRunPollSeconds: 1 },
      })
      runner.implementWorkflow(repository.spec, repository.fn)
      const worker = runner.newWorker({ concurrency: 2 })
      await worker.start()
      try {
        const handle = await runner.runWorkflow(repository.spec, {
          orgId: generateObjectId("org"),
          workspaceId: generateObjectId("ws"),
          upgradeRunId: generateObjectId("run"),
          repository: "acme/slow",
          url: "https://github.com/acme/slow",
          githubConnectionId: generateObjectId("con"),
          sha: "0".repeat(40),
          authorTime: new Date().toISOString(),
          capUsd: null,
        })
        const result = await handle.result({ timeoutMs: 60_000 })
        expect(result).toMatchObject({
          status: "failed",
          capped: false,
          report: [
            "The ingestion run did not finish in the time that the upgrade waits.",
          ],
        })
        const attempts = await getSystemDb().execute<{ count: string }>(sql`
        select count(*) from openworkflow.step_attempts
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_run_id = ${handle.workflowRun.id}
      `)
        expect(Number(attempts.rows[0]?.count)).toBeLessThanOrEqual(stepBudget)
        expect(Number(attempts.rows[0]?.count)).toBeGreaterThan(stepBudget - 2)
        // The run that never finished is canceled, so it spends no more.
        const ingestion = await getSystemDb().execute<{ id: string }>(sql`
        select id from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
      `)
        expect(ingestion.rows).toHaveLength(1)
        expect(
          await ingestionRunState(ingestion.rows[0]?.id ?? ""),
        ).toMatchObject({ done: true, status: "canceled" })
      } finally {
        await worker.stop()
      }
    },
  )
})
