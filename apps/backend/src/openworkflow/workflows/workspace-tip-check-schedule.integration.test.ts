import { eq } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  getWorkspaceById,
  getWorkspaceProjection,
  persistWorkspaceGraphResult,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"
import { workspaceTipCheckSchedule } from "./workspace-tip-check-schedule.js"

// The tip check queues its runs in the app namespace, so each fixture worker
// runs that namespace.
const namespaceId = openWorkflowNamespaceId()
const HOUR_MS = 3_600_000
/** The UTC hour `hours` after the hour of `at`. */
const hourAfter = (at: string | number, hours: number) =>
  new Date(new Date(at).getTime() + hours * HOUR_MS).toISOString().slice(0, 13)

async function activeProjection(f: NativeHydrationFixture) {
  const active = await withOrgIdContext(f.org, () =>
    getWorkspaceProjection(f.workspaceId),
  )
  if (active.kind !== "active") throw new Error("Expected active revision")
  return active
}

/** The stored first failure of a phase of the active revision. */
async function phaseFailure(
  f: NativeHydrationFixture,
  phase: "graph" | "index",
) {
  const row = await withOrgIdContext(f.org, () =>
    getWorkspaceById(f.workspaceId),
  )
  const failure = row?.hydratePhases?.[phase]?.failure
  if (!failure) throw new Error(`Expected a stored ${phase} failure`)
  return failure
}

async function runTipCheck(f: NativeHydrationFixture, hour: string) {
  const handle = await runWorkflowWithWorkerWake(workspaceTipCheck.spec, {
    orgId: f.org.id,
    hour,
  })
  await handle.result({ timeoutMs: 30_000 })
}

async function workspaceRuns(f: NativeHydrationFixture, workflowName: string) {
  return (await f.backend.listWorkflowRuns({ limit: 1000 })).data.filter(
    (run) =>
      run.workflowName === workflowName &&
      ((run.input as { workspaceId?: string }).workspaceId === f.workspaceId ||
        (run.input as { revision?: { workspaceId?: string } }).revision
          ?.workspaceId === f.workspaceId),
  )
}

it(
  "the tip check builds a failed graph again, with no new commit, and shows it as building meanwhile",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({ namespaceId }, async (f) => {
      await f.publish()
      const { revision } = await activeProjection(f)
      await withOrgIdContext(f.org, () =>
        persistWorkspaceGraphResult({
          revision,
          result: { kind: "failed", message: "Socket closed unexpectedly" },
        }),
      )

      // The first retry is in the check of the next hour.
      await runTipCheck(f, hourAfter((await phaseFailure(f, "graph")).at, 1))

      await vi.waitFor(
        async () =>
          expect((await activeProjection(f)).stores.graph.kind).toBe("ready"),
        { timeout: 30_000, interval: 100 },
      )
      const [retry, ...others] = (
        await workspaceRuns(f, workspaceHydrate.spec.name)
      ).filter((run) =>
        run.idempotencyKey?.startsWith("workspace-tip-hydrate:"),
      )
      expect(others).toEqual([])
      if (!retry) throw new Error("Expected a tip hydrate")
      expect((retry.input as { revision: { sha: string } }).revision.sha).toBe(
        f.sha,
      )
      // Before it built the graph, the retry set the phase back to pending,
      // which the Workspace pane shows as "Building graph".
      const steps = await f.backend.listStepAttempts({
        workflowRunId: retry.id,
      })
      expect(steps.data).toContainEqual(
        expect.objectContaining({
          stepName: "persist-graph-retry",
          status: "completed",
        }),
      )
    })
  },
)

it(
  "the tip check builds a failed index again, with no new commit",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({ namespaceId }, async (f) => {
      await f.publish()
      const { revision } = await activeProjection(f)
      const indexRunsBefore = (await workspaceRuns(f, "workspace-index")).length
      await withOrgIdContext(f.org, () =>
        persistWorkspaceIndexResult({
          revision,
          result: { kind: "failed", message: "codesearch is not reachable" },
        }),
      )

      await runTipCheck(f, hourAfter((await phaseFailure(f, "index")).at, 1))

      await vi.waitFor(
        async () => {
          const [retry] = (
            await workspaceRuns(f, workspaceHydrate.spec.name)
          ).filter((run) =>
            run.idempotencyKey?.startsWith("workspace-tip-hydrate:"),
          )
          expect(retry).toMatchObject({
            status: "completed",
            output: { hydrated: false, reason: "index_lag" },
          })
          const indexRuns = await workspaceRuns(f, "workspace-index")
          expect(indexRuns.length).toBeGreaterThan(indexRunsBefore)
          expect(indexRuns.map((run) => run.status)).not.toContain("pending")
        },
        { timeout: 30_000, interval: 100 },
      )
    })
  },
)

it(
  "the tip check queues no second hydrate while one of that SHA is unfinished",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({ namespaceId }, async (f) => {
      await f.publish()
      const { revision } = await activeProjection(f)
      await withOrgIdContext(f.org, () =>
        persistWorkspaceGraphResult({
          revision,
          result: { kind: "failed", message: "Socket closed unexpectedly" },
        }),
      )
      // A hydrate of the same SHA that is queued and not due yet.
      const unfinished = await runWorkflowWithWorkerWake(
        workspaceHydrate.spec,
        { orgId: f.org.id, workspaceId: f.workspaceId, revision },
        { availableAt: new Date(Date.now() + 86_400_000) },
      )

      await runTipCheck(f, hourAfter((await phaseFailure(f, "graph")).at, 1))

      const hydrates = (
        await workspaceRuns(f, workspaceHydrate.spec.name)
      ).filter((run) => run.id !== f.handle.workflowRun.id)
      expect(hydrates.map((run) => run.id)).toEqual([unfinished.workflowRun.id])
      expect((await activeProjection(f)).stores.graph.kind).toBe("failed")
    })
  },
)

it(
  "a failed graph waits 1, 2, 4, 8 and 16 hours, then 24 hours, and a retry keeps the first failure",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({ namespaceId }, async (f) => {
      await f.publish()
      const { revision } = await activeProjection(f)
      const fail = (message: string) =>
        withOrgIdContext(f.org, () =>
          persistWorkspaceGraphResult({
            revision,
            result: { kind: "failed", message },
          }),
        )
      await fail("Socket closed unexpectedly")
      const first = await phaseFailure(f, "graph")
      // A retry sets the phase to pending and keeps the failure, so a crash
      // in the retry loses neither its message nor its time.
      await withOrgIdContext(f.org, () =>
        persistWorkspaceGraphResult({ revision, result: { kind: "pending" } }),
      )
      expect(await phaseFailure(f, "graph")).toEqual(first)
      await fail("Connection refused")
      expect(await phaseFailure(f, "graph")).toEqual({
        message: "Connection refused",
        at: first.at,
      })

      // 3 hours after the first failure is between two retries.
      await runTipCheck(f, hourAfter(first.at, 3))

      const hydrates = (
        await workspaceRuns(f, workspaceHydrate.spec.name)
      ).filter((run) =>
        run.idempotencyKey?.startsWith("workspace-tip-hydrate:"),
      )
      expect(hydrates).toEqual([])
      expect((await activeProjection(f)).stores.graph.kind).toBe("failed")
    })
  },
)

it(
  "the schedule queues the next hour first, and the tip check of each org with a Workspace once an hour, but not for an hour that is over",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({ namespaceId }, async (f) => {
      // The clock stops in the current hour, so the hours below do not
      // change while the test runs.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
      const bare = {
        id: `org_bare_${f.id}`,
        name: "Bare",
        slug: `bare-${f.id}`,
      }
      await getSystemDb()
        .insert(organizations)
        .values({ ...bare, createdAt: new Date() })
      const runner = new OpenWorkflow({ backend: f.backend })
      runner.implementWorkflow(
        workspaceTipCheckSchedule.spec,
        workspaceTipCheckSchedule.fn,
      )
      // The schedule queues the tip check of each org in the database. This
      // worker runs only the schedule. It never runs a tip check, so it
      // cannot claim the real runs of other test files.
      const worker = runner.newWorker({ concurrency: 1 })
      await worker.start()
      try {
        const now = Date.now()
        const current = hourAfter(now, 0)
        const schedule = (hour: string) =>
          runWorkflowWithWorkerWake(workspaceTipCheckSchedule.spec, { hour })

        // The hour before the last one is over: its run queues only the
        // next hour. That run is over too, and it queues the current hour.
        const past = await schedule(hourAfter(now, -2))
        expect(await past.result({ timeoutMs: 30_000 })).toEqual({ queued: 0 })
        const runs = async () =>
          (await f.backend.listWorkflowRuns({ limit: 1000 })).data
        await vi.waitFor(
          async () => {
            const byKey = new Map(
              (await runs()).map((run) => [run.idempotencyKey, run]),
            )
            expect(
              byKey.get(`workspace-tip-check-schedule:${hourAfter(now, -1)}`)
                ?.status,
            ).toBe("completed")
            expect(
              byKey.get(`workspace-tip-check-schedule:${current}`)?.status,
            ).toBe("completed")
            expect(
              byKey.get(`workspace-tip-check-schedule:${hourAfter(now, 1)}`)
                ?.availableAt,
            ).toEqual(new Date(Date.parse(`${hourAfter(now, 1)}:00:00.000Z`)))
          },
          { timeout: 30_000, interval: 100 },
        )
        // A second run of the current hour queues no second check.
        await (await schedule(current)).result({ timeoutMs: 30_000 })

        const checks = (await runs()).filter(
          (run) =>
            run.workflowName === workspaceTipCheck.spec.name &&
            run.idempotencyKey?.startsWith("workspace-tip-check-hourly:"),
        )
        const own = checks.filter(
          (run) => (run.input as { orgId: string }).orgId === f.org.id,
        )
        expect(own.map((run) => run.idempotencyKey)).toEqual([
          `workspace-tip-check-hourly:${f.org.id}:${current}`,
        ])
        expect(own[0]?.input).toEqual({ orgId: f.org.id, hour: current })
        // The org gets one start time in the hour, from its id.
        const hourStart = Date.parse(`${current}:00:00.000Z`)
        const due = own[0]?.availableAt?.getTime() ?? Number.NaN
        expect(due).toBeGreaterThanOrEqual(hourStart)
        expect(due).toBeLessThan(hourStart + HOUR_MS)
        expect(
          checks.filter(
            (run) => (run.input as { orgId: string }).orgId === bare.id,
          ),
        ).toEqual([])
        expect(
          checks.filter((run) => !run.idempotencyKey?.endsWith(`:${current}`)),
        ).toEqual([])
      } finally {
        await worker.stop()
        vi.useRealTimers()
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, bare.id))
      }
    })
  },
)
