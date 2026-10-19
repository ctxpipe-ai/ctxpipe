import { eq, sql } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { orgFirstWorkspaces, workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { closeOpenWorkflowClient } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { defineWorkspaceUpgradeReingestRepository } from "../../openworkflow/workflows/workspace-upgrade-reingest.js"
import { defineWorkspaceUpgradeScan } from "../../openworkflow/workflows/workspace-upgrade-scan.js"
import {
  orgPendingUpgradeRoutes,
  workspaceUpgradeRoutes,
} from "../../routes/v1/workspace-upgrades-routes.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { ingestionRunState, reingestSlotTurn } from "./reingest.js"
import { startWorkspaceUpgrade } from "./start.js"
import { stopOrphanedReingestRuns } from "./stop-orphans.js"

/*
 * The re-ingestion throttle and the step budget of a long run, with real
 * Postgres and real OpenWorkflow runs. This file has its own OpenWorkflow
 * namespace, so it sees no run of another test file. No worker implements
 * ingestion v2 here, so each ingestion v2 run stays active.
 *
 * A worker claims each run of its namespace, but it knows only the workflows
 * that its OpenWorkflow instance implemented before `newWorker`. It fails a
 * run of another workflow as "not registered" and retries it after 5 s, 10 s,
 * 20 s. Thus a test registers all of its workflows before it starts its
 * worker, and it cancels its queued runs, so that the worker of the next test
 * does not run them.
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

afterEach(async () => {
  for (const id of queued.splice(0))
    await runner.cancelWorkflowRun(id).catch(() => undefined)
})

afterAll(async () => {
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
      reingestSlotTurn({
        orgId,
        upgradeRunId,
        runsPerInstance,
        workspaceId: generateObjectId("ws"),
        sourceUrls: [],
      })

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

describe("an ingestion run of a source of the Workspace", () => {
  it("makes the upgrade wait until that run ends, so the re-ingestion pins what it published", async () => {
    const orgId = generateObjectId("org")
    const workspaceId = generateObjectId("ws")
    const url = "https://github.com/acme/ky"
    const ingestionSpec = {
      name: INGESTION_V2_WORKFLOW_NAME,
      schema: z.object({ orgId: z.string() }).passthrough(),
    }
    // No worker runs ingestion v2 here: each queued run stays active.
    const ingestion = async (extra: Record<string, unknown>) => {
      const handle = await runner.runWorkflow(ingestionSpec, {
        orgId,
        shadow: false,
        source: {
          kind: "github",
          url,
          githubConnectionId: generateObjectId("con"),
        },
        sha: "a".repeat(40),
        authorTime: new Date().toISOString(),
        ...extra,
      })
      queued.push(handle.workflowRun.id)
      return handle.workflowRun.id
    }
    const upgradeRunId = await upgradeRun(orgId)
    const turn = () =>
      reingestSlotTurn({
        orgId,
        upgradeRunId,
        runsPerInstance: 4,
        workspaceId,
        sourceUrls: ["https://github.com/Acme/Ky"],
      })

    // A shadow run and a run for another Workspace publish nothing here.
    await ingestion({ shadow: true })
    await ingestion({ destinations: [generateObjectId("ws")] })
    expect(await turn()).toEqual({ turn: true })

    // A re-index of the source can publish to each Workspace of it.
    const reindex = await ingestion({})
    expect(await turn()).toEqual({
      wait: "An ingestion run of a source repository of this Workspace has not ended. The re-ingestion starts after it.",
    })
    await runner.cancelWorkflowRun(reindex)
    expect(await turn()).toEqual({ turn: true })

    const named = await ingestion({ destinations: [workspaceId] })
    expect(await turn()).toHaveProperty("wait")
    await runner.cancelWorkflowRun(named)
    expect(await turn()).toEqual({ turn: true })
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
      const orgId = generateObjectId("org")
      try {
        const handle = await runner.runWorkflow(repository.spec, {
          orgId,
          workspaceId: generateObjectId("ws"),
          upgradeRunId: generateObjectId("run"),
          repository: "acme/slow",
          url: "https://github.com/acme/slow",
          githubConnectionId: generateObjectId("con"),
          sha: "0".repeat(40),
          authorTime: new Date().toISOString(),
          doneRoots: [],
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
          and input->>'orgId' = ${orgId}
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

/**
 * Start a parent run that runs one repository run with `step.runWorkflow`,
 * as the real parent does, wait until that repository run started its
 * ingestion run, and cancel the parent. The repository run is then an
 * orphan: it keeps running.
 */
async function orphanedRepositoryRun(orgId: string) {
  const fleet = new OpenWorkflow({ backend })
  const repository = defineWorkspaceUpgradeReingestRepository({
    throttle: { firstPollSeconds: 1, maxRunPollSeconds: 1 },
  })
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
          doneRoots: [],
        },
        { name: "repository:0" },
      ),
  }
  const scan = defineWorkspaceUpgradeScan([])
  fleet.implementWorkflow(repository.spec, repository.fn)
  fleet.implementWorkflow(parent.spec, parent.fn as never)
  fleet.implementWorkflow(scan.spec, scan.fn)
  const worker = fleet.newWorker({ concurrency: 4 })
  await worker.start()
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
  const handle = await fleet.runWorkflow(parent.spec, { orgId })
  queued.push(handle.workflowRun.id)
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
  await fleet.cancelWorkflowRun(handle.workflowRun.id)
  expect((await statusOf("workspace-upgrade-reingest"))?.status).toBe(
    "canceled",
  )
  expect(
    (await statusOf("workspace-upgrade-reingest-repository"))?.status,
  ).toMatch(/running|sleeping|pending/)
  return { fleet, worker, statusOf, scan }
}

describe("a parent run that ends before its repository runs", () => {
  it(
    "cancels the repository run and its ingestion runs, and keeps the slot until they ended",
    { timeout: 90_000 },
    async () => {
      const orgId = generateObjectId("org")
      const { worker, statusOf } = await orphanedRepositoryRun(orgId)
      try {
        // The next run of the org waits: the slot is not free yet.
        const next = await upgradeRun(orgId)
        expect(
          await reingestSlotTurn({
            orgId,
            upgradeRunId: next,
            runsPerInstance: 4,
            workspaceId: generateObjectId("ws"),
            sourceUrls: [],
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
            workspaceId: generateObjectId("ws"),
            sourceUrls: [],
          }),
        ).toEqual({ turn: true })
      } finally {
        await worker.stop()
      }
    },
  )

  it(
    "keeps the orphan through the upgrade reads and a start, and the upgrade scan cancels it with one sweep for the org",
    { timeout: 90_000 },
    async () => {
      const org = { id: generateObjectId("org"), slug: "", name: "Sweep" }
      org.slug = org.id
      const slugs = ["sweep-a", "sweep-b"]
      await getSystemDb().insert(organizations).values({
        id: org.id,
        slug: org.slug,
        name: org.name,
        createdAt: new Date(),
      })
      for (const slug of slugs)
        await withOrgDbContext(org.id, (db) =>
          db.insert(workspaces).values({
            id: generateObjectId("ws"),
            orgId: org.id,
            slug,
            displayName: slug,
            workspaceRepositoryUrl: `https://github.com/acme/${slug}-${org.id}`,
            desiredGeneration: 1,
            formatVersion: 3,
          }),
        )
      const { fleet, worker, statusOf, scan } = await orphanedRepositoryRun(
        org.id,
      )
      try {
        // The reads and a start that finds no row cancel nothing.
        for (const [routes, path] of [
          [workspaceUpgradeRoutes, `/workspaces/${slugs[0]}/upgrades`],
          [orgPendingUpgradeRoutes, "/workspaces/pending"],
        ] as const) {
          const response = await workspaceHttpApp(org, routes).request(path)
          expect(response.status).toBe(200)
        }
        const [first] = await withOrgDbContext(org.id, (db) =>
          db.select().from(workspaces).where(eq(workspaces.orgId, org.id)),
        )
        expect(
          await withOrgIdContext(org, () =>
            startWorkspaceUpgrade({
              orgId: org.id,
              workspaceId: first?.id ?? "",
              key: "format-3",
              userId: "user_sweep",
            }),
          ),
        ).toEqual({ kind: "missing" })
        expect(
          (await statusOf("workspace-upgrade-reingest-repository"))?.status,
        ).toMatch(/running|sleeping|pending/)

        const handle = await fleet.runWorkflow(scan.spec, {
          orgId: org.id,
          release: "test",
          trigger: "sweep",
        })
        await handle.result({ timeoutMs: 30_000 })
        // A worker that knows the scan ran it at the first claim.
        const scanRun = await getSystemDb().execute<{ attempts: number }>(sql`
          select attempts from openworkflow.workflow_runs
          where namespace_id = ${openWorkflowNamespaceId()}
            and id = ${handle.workflowRun.id}
        `)
        expect(scanRun.rows[0]).toEqual({ attempts: 1 })
        expect(
          (await statusOf("workspace-upgrade-reingest-repository"))?.status,
        ).toBe("canceled")
        expect((await statusOf(INGESTION_V2_WORKFLOW_NAME))?.status).toBe(
          "canceled",
        )
        // One sweep for the scan of the org, not one for each Workspace.
        const sweeps = await getSystemDb().execute<{ steps: number }>(sql`
          select count(*)::int as steps from openworkflow.step_attempts
          where namespace_id = ${openWorkflowNamespaceId()}
            and workflow_run_id = ${handle.workflowRun.id}
            and step_name = 'stop-orphaned-reingest-runs'
        `)
        expect(sweeps.rows[0]).toEqual({ steps: 1 })
      } finally {
        await worker.stop()
        await withOrgDbContext(org.id, async (db) => {
          await db
            .delete(orgFirstWorkspaces)
            .where(eq(orgFirstWorkspaces.orgId, org.id))
          await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
        })
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, org.id))
      }
    },
  )
})
