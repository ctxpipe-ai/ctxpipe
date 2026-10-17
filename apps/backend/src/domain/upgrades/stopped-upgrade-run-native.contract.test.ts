import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import {
  getWorkspaceUpgradeRow,
  insertWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import {
  orgPendingUpgradeRoutes,
  workspaceUpgradeRoutes,
} from "../../routes/v1/workspace-upgrades-routes.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { upgradeJobId } from "./registry.js"

it(
  "the upgrade reads write nothing, and the tip check sets an upgrade run that stopped without its result to failed",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const key = "format-3"
        // An upgrade run that no worker claims, then canceled: it ended
        // without its result.
        const handle = await f.runner.runWorkflow(
          {
            name: "workspace-upgrade",
            schema: z.object({ workspaceId: z.string() }),
          },
          { workspaceId: f.workspaceId },
          { availableAt: new Date(Date.now() + 3_600_000) },
        )
        await f.runner.cancelWorkflowRun(handle.workflowRun.id)
        await withOrgIdContext(f.org, async () => {
          await insertWorkspaceUpgradeRow({
            workspaceId: f.workspaceId,
            generation: 1,
            status: "running",
            upgrade: { key, fromFormat: 0, targetFormat: 3 },
          })
          await transitionWorkspaceUpgradeRow({
            workspaceId: f.workspaceId,
            key,
            from: ["running"],
            to: "running",
            workflowRunId: handle.workflowRun.id,
          })
        })
        const stored = async () =>
          withOrgDbContext(f.org.id, async (db) => {
            const [row] = await db
              .select({
                status: workspaceWriteJobs.status,
                payload: workspaceWriteJobs.payload,
                updatedAt: workspaceWriteJobs.updatedAt,
              })
              .from(workspaceWriteJobs)
              .where(
                eq(workspaceWriteJobs.id, upgradeJobId(f.workspaceId, key)),
              )
            return row
          })
        const before = await stored()
        expect(before?.status).toBe("running")

        const read = async () => {
          const one = await workspaceHttpApp(
            f.org,
            workspaceUpgradeRoutes,
          ).request("/workspaces/knowledge/upgrades")
          const org = await workspaceHttpApp(
            f.org,
            orgPendingUpgradeRoutes,
          ).request("/workspaces/pending")
          expect([one.status, org.status]).toEqual([200, 200])
          const pending = (await org.json()) as {
            workspaces: Array<{
              workspaceSlug: string
              items: Array<{ key: string; status: string }>
            }>
          }
          return {
            one: ((await one.json()) as { items: Array<{ status: string }> })
              .items[0]?.status,
            org: pending.workspaces.map((workspace) => ({
              workspaceSlug: workspace.workspaceSlug,
              statuses: workspace.items.map((item) => item.status),
            })),
          }
        }

        // Both reads show the stored row and change no column of it.
        expect(await read()).toEqual({
          one: "running",
          org: [{ workspaceSlug: "knowledge", statuses: ["running"] }],
        })
        expect(await stored()).toEqual(before)

        const tip = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await tip.result({ timeoutMs: 60_000 })
        expect(
          await withOrgIdContext(f.org, () =>
            getWorkspaceUpgradeRow(f.workspaceId, key),
          ),
        ).toMatchObject({
          status: "failed",
          failureReason: "The upgrade run stopped before it finished.",
        })
        expect(await read()).toEqual({
          one: "failed",
          org: [{ workspaceSlug: "knowledge", statuses: ["failed"] }],
        })
      },
    )
  },
)
