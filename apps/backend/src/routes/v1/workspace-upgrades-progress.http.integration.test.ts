import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { runUpgradeStage } from "../../domain/upgrades/run-stage.js"
import {
  insertWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceUpgradeRoutes } from "./workspace-upgrades-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_upgrade_progress_${suffix}`,
  slug: `upgrade-progress-${suffix}`,
  name: "Upgrade progress",
}
const workspaceId = `ws_progress_${suffix}`
const key = "format-3"

type Item = {
  status: string
  runStage: { name: string; since: string } | null
  mergedAt: string | null
  checkedAt: string | null
}

async function readItem(): Promise<Item> {
  const response = await withOrgDbContext(org.id, async () =>
    workspaceHttpApp(org, workspaceUpgradeRoutes).request(
      "/workspaces/progress/upgrades",
    ),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { items: Item[] }
  const [item] = body.items
  if (!item) throw new Error("The Workspace has no upgrade item")
  return item
}

describe("Upgrade progress on the upgrades read (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await withOrgDbContext(org.id, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: "progress",
        displayName: "progress",
        workspaceRepositoryUrl: `https://github.com/example/progress-${suffix}.git`,
        formatVersion: 2,
      }),
    )
    await withOrgIdContext(org, () =>
      insertWorkspaceUpgradeRow({
        workspaceId,
        generation: 1,
        status: "running",
        upgrade: { key, fromFormat: 2, targetFormat: 3 },
      }).then(() =>
        transitionWorkspaceUpgradeRow({
          workspaceId,
          key,
          from: ["running"],
          to: "running",
          workflowRunId: "run_progress",
        }),
      ),
    )
  })

  afterAll(async () => {
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
    )
    await closeDb()
  })

  it("shows the stage while a run is in it, and drops the stage when the row leaves running", async () => {
    await withOrgIdContext(org, async () => {
      const seen = await runUpgradeStage(
        { workspaceId, key, runId: "run_progress", stage: "build" },
        readItem,
      )
      expect(seen.runStage?.name).toBe("build")
      expect(Date.parse(seen.runStage?.since ?? "")).not.toBeNaN()
      expect((await readItem()).runStage?.name).toBe("build")
      // A run that another run owns does not change the stage.
      await runUpgradeStage(
        { workspaceId, key, runId: "run_other", stage: "push" },
        async () => undefined,
      )
      expect((await readItem()).runStage?.name).toBe("build")
      await transitionWorkspaceUpgradeRow({
        workspaceId,
        key,
        from: ["running"],
        to: "pr_open",
        ownerRunId: "run_progress",
        upgrade: { prNumber: 7, prUrl: "https://github.com/example/p/pull/7" },
      })
    })
    const item = await withOrgIdContext(org, readItem)
    expect(item.status).toBe("pr_open")
    expect(item.runStage).toBeNull()
  })

  it("shows when ctx| saw the merge and when it checked last", async () => {
    const before = await withOrgIdContext(org, readItem)
    expect(before.mergedAt).toBeNull()
    await withOrgIdContext(org, () =>
      transitionWorkspaceUpgradeRow({
        workspaceId,
        key,
        from: ["pr_open"],
        to: "pr_open",
        upgrade: {
          mergedAt: "2026-10-20T12:00:00.000Z",
          checkedAt: "2026-10-20T12:00:05.000Z",
        },
      }),
    )
    const after = await withOrgIdContext(org, readItem)
    expect(after.mergedAt).toBe("2026-10-20T12:00:00.000Z")
    expect(after.checkedAt).toBe("2026-10-20T12:00:05.000Z")
  })
})
