import { sql } from "drizzle-orm"
import { expect, it } from "vitest"

import { getSystemDb } from "../../db/client.js"
import { defineWorkspaceUpgradeScan } from "../../openworkflow/workflows/workspace-upgrade-scan.js"
import { workspaceUpgradeRoutes } from "../../routes/v1/workspace-upgrades-routes.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { GIT_UPGRADE_STEPS } from "./registry.js"

it(
  "queues the upgrade scan when hydrate first reads a repository with no format file, and the scan shows the format upgrade as blocked on write access",
  { timeout: 150_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        // No GitHub App and no format file: a read-only public repository.
        writeStatus: "read_only",
        files: [{ path: "knowledge/a.md", body: "# A\n" }],
      },
      async (f) => {
        await f.worker.start()
        expect(await f.handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
        })
        // The first read of the format (null to 0) queues the scan. Worker
        // start queued none for this Workspace: it did not exist then.
        const queued = await getSystemDb().execute(sql`
          select count(*)::int as runs from openworkflow.workflow_runs
          where input->>'orgId' = ${f.org.id}
            and workflow_name = 'workspace-upgrade-scan'
        `)
        expect(queued.rows[0]).toMatchObject({ runs: 1 })

        // The fixture worker does not know the scan. If it claimed the scan
        // run, it would put the run back for 5 s, then 10 s, and so on. Only
        // the scan worker may claim it.
        await f.worker.stop()
        const scan = defineWorkspaceUpgradeScan(GIT_UPGRADE_STEPS)
        f.runner.implementWorkflow(scan.spec, scan.fn)
        const scanWorker = f.runner.newWorker({ concurrency: 1 })
        await scanWorker.start()
        const handle = await f.runner.runWorkflow(scan.spec, {
          orgId: f.org.id,
          release: "test",
          trigger: "test",
        })
        try {
          await handle.result({ timeoutMs: 30_000 })
        } catch (error) {
          // A timeout names no step. Say where the run stopped.
          const state = await getSystemDb().execute(sql`
            select r.status, r.available_at, r.worker_id, r.error,
              (select json_agg(json_build_object('step', s.step_name,
                'status', s.status, 'started', s.created_at, 'error', s.error)
                order by s.created_at)
               from openworkflow.step_attempts s
               where s.namespace_id = r.namespace_id
                 and s.workflow_run_id = r.id) as steps
            from openworkflow.workflow_runs r
            where r.id = ${handle.workflowRun.id}
          `)
          throw new Error(
            `The scan run did not finish: ${JSON.stringify(state.rows)}`,
            { cause: error },
          )
        } finally {
          await scanWorker.stop()
        }

        const response = await workspaceHttpApp(
          f.org,
          workspaceUpgradeRoutes,
        ).request("/workspaces/knowledge/upgrades")
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          formatVersion: number
          items: Array<{
            key: string
            status: string
            blockedReason: string | null
            note: string | null
          }>
        }
        expect(body.formatVersion).toBe(0)
        expect(
          body.items.find((item) => item.key === "format-3"),
        ).toMatchObject({
          status: "blocked",
          blockedReason: "write_access",
          note: expect.stringContaining(
            "needs write access through the GitHub App to open the upgrade pull request",
          ),
        })
      },
    )
  },
)
