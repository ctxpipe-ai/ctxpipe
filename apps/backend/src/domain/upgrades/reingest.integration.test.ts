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
import { stopOrphanedReingestRuns } from "./stop-orphans.js"

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

/** Set the `created_at` of a run. */
async function startedAt(id: string, at: Date): Promise<void> {
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs set created_at = ${at.toISOString()}
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${id}
  `)
}

describe("re-ingestion throttle", () => {
  it("gives the slot of an org to its first upgrade run until that run ends, and caps the runs of the instance", async () => {
    const [orgA, orgB, orgC] = [
      generateObjectId("org"),
      generateObjectId("org"),
      generateObjectId("org"),
    ]
    const runs = {
      a1: await upgradeRun(orgA),
      a2: await upgradeRun(orgA),
      other: await upgradeRun(orgB),
      third: await upgradeRun(orgC),
    }
    // The two runs of org A start in the same millisecond: the run id
    // orders them, so the same run gets the slot each time.
    const at = Date.now()
    await startedAt(runs.a1, new Date(at))
    await startedAt(runs.a2, new Date(at))
    await startedAt(runs.other, new Date(at + 1))
    await startedAt(runs.third, new Date(at + 2))
    const [first = "", second = ""] = [runs.a1, runs.a2].sort()
    const [other, third] = [runs.other, runs.third]
    const turn = (orgId: string, upgradeRunId: string, runsPerInstance = 4) =>
      reingestSlotTurn({ orgId, upgradeRunId, runsPerInstance })

    for (let ask = 0; ask < 3; ask++) {
      expect(await turn(orgA, first)).toEqual({ turn: true })
      // The slot stays with the first run, also between its repositories.
      expect(await turn(orgA, second)).toEqual({
        wait: "A re-ingestion of another Workspace of this organization runs.",
      })
    }
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

describe("a parent run that ends before its repository runs", () => {
  it(
    "cancels the repository run and its ingestion runs, and keeps the slot until they ended",
    { timeout: 90_000 },
    async () => {
      const fleet = new OpenWorkflow({ backend })
      const repository = defineWorkspaceUpgradeReingestRepository({
        throttle: { firstPollSeconds: 1, maxRunPollSeconds: 1 },
      })
      // A parent that does what the real one does for its children: it runs
      // one repository run with `step.runWorkflow`, then waits for it.
      const parent = {
        spec: upgradeSpec,
        fn: async ({
          input,
          step,
          run,
        }: {
          input: { orgId: string }
          step: {
            runWorkflow: (
              spec: typeof repository.spec,
              input: unknown,
              options: { name: string },
            ) => Promise<unknown>
          }
          run: { id: string }
        }) =>
          step.runWorkflow(
            repository.spec,
            {
              orgId: input.orgId,
              workspaceId: generateObjectId("ws"),
              upgradeRunId: run.id,
              repository: "acme/orphan",
              url: "https://github.com/acme/orphan",
              githubConnectionId: generateObjectId("con"),
              sha: "0".repeat(40),
              authorTime: new Date().toISOString(),
              capUsd: null,
            },
            { name: "repository:0" },
          ),
      }
      fleet.implementWorkflow(repository.spec, repository.fn)
      fleet.implementWorkflow(parent.spec, parent.fn as never)
      const worker = fleet.newWorker({ concurrency: 4 })
      await worker.start()
      const orgId = generateObjectId("org")
      const statusOf = async (workflowName: string) => {
        const result = await getSystemDb().execute<{
          id: string
          status: string
        }>(sql`
          select id, status from openworkflow.workflow_runs
          where namespace_id = ${openWorkflowNamespaceId()}
            and workflow_name = ${workflowName}
            and input->>'orgId' = ${orgId}
        `)
        return result.rows[0]
      }
      try {
        const handle = await fleet.runWorkflow(parent.spec, { orgId })
        queued.push(handle.workflowRun.id)
        const parentId = handle.workflowRun.id
        // The repository run has started its ingestion run.
        let child: { id: string; status: string } | undefined
        for (let i = 0; i < 60; i++) {
          child = await statusOf("workspace-upgrade-reingest-repository")
          const started = await getSystemDb().execute(sql`
            select 1 from openworkflow.workflow_runs
            where namespace_id = ${openWorkflowNamespaceId()}
              and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
              and idempotency_key like ${`upgrade-reingest:${orgId}:%`}
          `)
          if (child && started.rows.length) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        expect(child?.status).toMatch(/running|sleeping|pending/)

        // The parent is canceled. Its child keeps running.
        await fleet.cancelWorkflowRun(parentId)
        expect((await statusOf("workspace-upgrade-reingest"))?.status).toBe(
          "canceled",
        )
        expect(
          (await statusOf("workspace-upgrade-reingest-repository"))?.status,
        ).toMatch(/running|sleeping|pending/)
        // The next run of the org waits: the slot is not free yet.
        const next = await upgradeRun(orgId)
        expect(
          await reingestSlotTurn({
            orgId,
            upgradeRunId: next,
            runsPerInstance: 4,
          }),
        ).toEqual({
          wait: "A repository run of an earlier re-ingestion of this organization has not ended.",
        })

        await stopOrphanedReingestRuns()
        expect(
          (await statusOf("workspace-upgrade-reingest-repository"))?.status,
        ).toBe("canceled")
        const ingestion = await statusOf(INGESTION_V2_WORKFLOW_NAME)
        expect(ingestion?.status).toBe("canceled")
        expect(
          await reingestSlotTurn({
            orgId,
            upgradeRunId: next,
            runsPerInstance: 4,
          }),
        ).toEqual({ turn: true })
      } finally {
        await worker.stop()
      }
    },
  )
})
