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

        const scan = defineWorkspaceUpgradeScan(GIT_UPGRADE_STEPS)
        f.runner.implementWorkflow(scan.spec, scan.fn)
        const scanWorker = f.runner.newWorker({ concurrency: 1 })
        await scanWorker.start()
        const handle = await f.runner.runWorkflow(scan.spec, {
          orgId: f.org.id,
          release: "test",
          trigger: "test",
        })
        await handle.result({ timeoutMs: 30_000 })
        await scanWorker.stop()

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
