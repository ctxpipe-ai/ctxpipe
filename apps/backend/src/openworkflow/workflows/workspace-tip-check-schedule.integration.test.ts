import { expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
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
import { enqueueHourlyTipCheck } from "./workspace-tip-check-schedule.js"

// The hourly tip check queues its runs in the app namespace, so each fixture
// worker runs that namespace. The previous UTC hour: the check of each org
// in that hour is due now.
const namespaceId = openWorkflowNamespaceId()
const previousHour = () =>
  new Date(Date.now() - 3_600_000).toISOString().slice(0, 13)

async function activeProjection(f: NativeHydrationFixture) {
  const active = await withOrgIdContext(f.org, () =>
    getWorkspaceProjection(f.workspaceId),
  )
  if (active.kind !== "active") throw new Error("Expected active revision")
  return active
}

async function runHourlyTipCheck(f: NativeHydrationFixture, hour: string) {
  const handle = await enqueueHourlyTipCheck(f.org.id, hour)
  const hourStart = Date.parse(`${hour}:00:00.000Z`)
  const due = handle.workflowRun.availableAt?.getTime() ?? Number.NaN
  // The org gets one start time in the hour, from its id.
  expect(due).toBeGreaterThanOrEqual(hourStart)
  expect(due).toBeLessThan(hourStart + 3_600_000)
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
  "the hourly tip check builds a failed graph again, with no new commit, and shows it as building meanwhile",
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

      await runHourlyTipCheck(f, previousHour())

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
  "the hourly tip check builds a failed index again, with no new commit",
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

      await runHourlyTipCheck(f, previousHour())

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
  "the hourly tip check queues no second hydrate while one of that SHA is unfinished",
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

      await runHourlyTipCheck(f, previousHour())

      const hydrates = (
        await workspaceRuns(f, workspaceHydrate.spec.name)
      ).filter((run) => run.id !== f.handle.workflowRun.id)
      expect(hydrates.map((run) => run.id)).toEqual([unfinished.workflowRun.id])
      expect((await activeProjection(f)).stores.graph.kind).toBe("failed")
    })
  },
)
