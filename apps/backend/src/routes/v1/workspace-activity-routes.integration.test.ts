import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  insertWorkspaceRepositoryCommits,
  upsertWorkspaceCommitProjection,
} from "../../models/workspace-commits.js"
import { deleteWorkspace } from "../../models/workspaces.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import {
  orgActivityRoutes,
  workspaceActivityRoutes,
} from "./workspace-activity-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_activity_${suffix}`,
  slug: `activity-${suffix}`,
  name: "Activity",
}
const workspace = { id: `ws_activity_${suffix}`, slug: `docs-${suffix}` }
const wiki = { id: `ws_activity_wiki_${suffix}`, slug: `wiki-${suffix}` }
const otherOrg = {
  id: `org_test_activity_other_${suffix}`,
  slug: `activity-other-${suffix}`,
  name: "Other",
}
const otherWorkspace = {
  id: `ws_activity_other_${suffix}`,
  slug: `docs-${suffix}`,
}
const unprojected = {
  id: `ws_activity_unprojected_${suffix}`,
  slug: `new-${suffix}`,
}
const idle = { id: `ws_activity_idle_${suffix}`, slug: `idle-${suffix}` }
const polled = { id: `ws_activity_polled_${suffix}`, slug: `polled-${suffix}` }
const newOrg = {
  id: `org_test_activity_new_${suffix}`,
  slug: `activity-new-${suffix}`,
  name: "New",
}
const fresh = { id: `ws_activity_fresh_${suffix}`, slug: `fresh-${suffix}` }
const failedOrg = {
  id: `org_test_activity_failed_${suffix}`,
  slug: `activity-failed-${suffix}`,
  name: "Failed",
}
const readyWorkspace = {
  id: `ws_activity_ready_${suffix}`,
  slug: `api-${suffix}`,
}
const deletedWorkspace = {
  id: `ws_activity_deleted_${suffix}`,
  slug: `deleted-${suffix}`,
}
const failedWorkspace = {
  id: `ws_activity_failed_${suffix}`,
  slug: `docs-${suffix}`,
}

// Days in the heatmap window: `day` is three UTC days before today.
const DAY_MS = 86_400_000
const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS
const day = new Date(dayStart).toISOString().slice(0, 10)
const quietDay = new Date(dayStart - 5 * DAY_MS).toISOString().slice(0, 10)

function commit(sha: string, offsetMs: number) {
  return {
    sha: sha.repeat(40),
    committedAt: new Date(dayStart + offsetMs),
    authorName: "Ada",
    subject: `Commit ${sha}`,
    htmlUrl: null,
  }
}

async function projectionRunCount(workspaceId: string) {
  const result = await getSystemDb().execute<{ count: number }>(
    sql`select count(*)::int as count from openworkflow.workflow_runs where workflow_name = 'workspace-commit-projection' and input->>'workspaceId' = ${workspaceId}`,
  )
  return result.rows[0]?.count ?? 0
}

/**
 * Sends 10 reads at the start of one 5-minute run window, so the reads never
 * cross a window edge. Only Date is fake.
 */
async function pollTenTimesInOneWindow(
  read: () => Response | Promise<Response>,
) {
  const windowStart = Math.floor(Date.now() / 300_000) * 300_000
  vi.useFakeTimers({ toFake: ["Date"], now: windowStart + 1_000 })
  try {
    for (let poll = 0; poll < 10; poll += 1) {
      expect((await read()).status).toBe(200)
    }
  } finally {
    vi.useRealTimers()
  }
}

async function seedWorkspace(
  target: typeof org,
  row: { id: string; slug: string },
  options: { projected: boolean; status?: "ready" | "failed" } = {
    projected: true,
  },
) {
  await withOrgDbContext(target.id, (db) =>
    db.insert(workspaces).values({
      id: row.id,
      orgId: target.id,
      slug: row.slug,
      displayName: row.slug,
      workspaceRepositoryUrl: `https://github.com/example/${row.slug}.git`,
    }),
  )
  if (!options.projected) return
  // A ready projection with no desired SHA is fresh, so the read enqueues nothing.
  await withOrgIdContext(target, () =>
    upsertWorkspaceCommitProjection({
      workspaceId: row.id,
      headSha: null,
      backfillStatus: options.status ?? "ready",
    }),
  )
}

describe("workspace activity routes (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await seedWorkspace(org, workspace)
    await withOrgIdContext(org, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: workspace.id,
        commits: [
          commit("a", -1_000),
          commit("b", 0),
          commit("c", 10 * 3_600_000),
          commit("d", DAY_MS - 1_000),
          commit("e", DAY_MS),
          commit("f", DAY_MS + 8 * 3_600_000),
        ],
      }),
    )
    await seedWorkspace(org, wiki)
    await withOrgIdContext(org, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: wiki.id,
        commits: [commit("g", 12 * 3_600_000)],
      }),
    )
    await seedWorkspace(otherOrg, otherWorkspace)
    await withOrgIdContext(otherOrg, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: otherWorkspace.id,
        commits: [commit("x", 11 * 3_600_000)],
      }),
    )
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' in (${org.id}, ${otherOrg.id}, ${failedOrg.id}, ${newOrg.id})`,
    )
    await withOrgDbContext(failedOrg.id, (db) =>
      db
        .delete(workspaces)
        .where(inArray(workspaces.id, [readyWorkspace.id, failedWorkspace.id])),
    )
    await withOrgDbContext(newOrg.id, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [fresh.id])),
    )
    await withOrgDbContext(org.id, (db) =>
      db
        .delete(workspaces)
        .where(inArray(workspaces.id, [workspace.id, wiki.id])),
    )
    await withOrgDbContext(otherOrg.id, (db) =>
      db
        .delete(workspaces)
        .where(
          inArray(workspaces.id, [
            otherWorkspace.id,
            unprojected.id,
            idle.id,
            polled.id,
          ]),
        ),
    )
    // The routes import the OpenWorkflow client, which connects on import.
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
    await closeDb()
  })

  it("returns the five latest commits without a date", async () => {
    const app = workspaceHttpApp(org, workspaceActivityRoutes)
    const res = await app.request(`/workspaces/${workspace.slug}/activity`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.recent.map((row: { subject: string }) => row.subject)).toEqual([
      "Commit f",
      "Commit e",
      "Commit d",
      "Commit c",
      "Commit b",
    ])
  })

  it("returns the commits of one UTC day, the same day as the heatmap count", async () => {
    const app = workspaceHttpApp(org, workspaceActivityRoutes)
    const res = await app.request(
      `/workspaces/${workspace.slug}/activity?date=${day}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.recent.map((row: { subject: string }) => row.subject)).toEqual([
      "Commit d",
      "Commit c",
      "Commit b",
    ])
    expect(
      body.days.find((row: { date: string }) => row.date === day)?.count,
    ).toBe(body.recent.length)

    const empty = await app.request(
      `/workspaces/${workspace.slug}/activity?date=${quietDay}`,
    )
    expect((await empty.json()).recent).toEqual([])
  })

  it("rejects a date that is not YYYY-MM-DD", async () => {
    const app = workspaceHttpApp(org, workspaceActivityRoutes)
    for (const date of ["2026-13-01", "26-08-2026", "yesterday"]) {
      const res = await app.request(
        `/workspaces/${workspace.slug}/activity?date=${date}`,
      )
      expect(res.status).toBe(400)
    }
  })

  it("reads the commits of every workspace in the org, with the workspace of each", async () => {
    // The fixture mounts the routes under `/workspaces`.
    const app = workspaceHttpApp(org, orgActivityRoutes)
    const res = await app.request("/workspaces")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ready")
    expect(
      body.recent.map(
        (row: { subject: string; workspaceSlug: string }) =>
          `${row.workspaceSlug}/${row.subject}`,
      ),
    ).toEqual([
      `${workspace.slug}/Commit f`,
      `${workspace.slug}/Commit e`,
      `${workspace.slug}/Commit d`,
      `${wiki.slug}/Commit g`,
      `${workspace.slug}/Commit c`,
    ])
    expect(body.recent[3]).toMatchObject({ workspaceName: wiki.slug })

    const dayRes = await app.request(`/workspaces?date=${day}`)
    const dayBody = await dayRes.json()
    expect(
      dayBody.recent.map((row: { subject: string }) => row.subject),
    ).toEqual(["Commit d", "Commit g", "Commit c", "Commit b"])
    expect(
      dayBody.days.find((row: { date: string }) => row.date === day)?.count,
    ).toBe(4)

    expect((await app.request("/workspaces?date=today")).status).toBe(400)
  })

  it("never shows the commits of another org", async () => {
    const app = workspaceHttpApp(otherOrg, orgActivityRoutes)
    const body = await (await app.request(`/workspaces?date=${day}`)).json()
    expect(body.recent.map((row: { subject: string }) => row.subject)).toEqual([
      "Commit x",
    ])
    expect(
      body.days.find((row: { date: string }) => row.date === day)?.count,
    ).toBe(1)

    // The other org's workspace with the same slug does not leak either.
    const scoped = workspaceHttpApp(otherOrg, workspaceActivityRoutes)
    const scopedBody = await (
      await scoped.request(`/workspaces/${otherWorkspace.slug}/activity`)
    ).json()
    expect(
      scopedBody.recent.map((row: { subject: string }) => row.subject),
    ).toEqual(["Commit x"])
  })

  it("is ready with the pending workspaces listed when one workspace is ready", async () => {
    await seedWorkspace(otherOrg, unprojected, { projected: false })
    const app = workspaceHttpApp(otherOrg, orgActivityRoutes)
    const body = await (await app.request("/workspaces")).json()
    expect(body.status).toBe("ready")
    expect(body.pendingWorkspaces).toEqual([
      { slug: unprojected.slug, name: unprojected.slug },
    ])
    expect(body.recent.map((row: { subject: string }) => row.subject)).toEqual([
      "Commit x",
    ])
  })

  it("is pending only when no workspace in the org is ready", async () => {
    await seedWorkspace(newOrg, fresh, { projected: false })
    const app = workspaceHttpApp(newOrg, orgActivityRoutes)
    const body = await (await app.request("/workspaces")).json()
    expect(body.status).toBe("pending")
    expect(body.pendingWorkspaces).toEqual([
      { slug: fresh.slug, name: fresh.slug },
    ])
  })

  it("starts one projection run per pending workspace over 10 polls", async () => {
    await seedWorkspace(otherOrg, idle, { projected: false })
    const app = workspaceHttpApp(otherOrg, orgActivityRoutes)
    await pollTenTimesInOneWindow(() => app.request("/workspaces"))
    await vi.waitFor(
      async () => expect(await projectionRunCount(idle.id)).toBeGreaterThan(0),
      { timeout: 3_000 },
    )
    await new Promise((settle) => setTimeout(settle, 500))
    expect(await projectionRunCount(idle.id)).toBe(1)
    expect(await projectionRunCount(unprojected.id)).toBe(1)
    // A ready projection is fresh, so the org read starts no run for it.
    expect(await projectionRunCount(otherWorkspace.id)).toBe(0)
  })

  it("starts one projection run over 10 workspace reads", async () => {
    await seedWorkspace(otherOrg, polled, { projected: false })
    const app = workspaceHttpApp(otherOrg, workspaceActivityRoutes)
    await pollTenTimesInOneWindow(() =>
      app.request(`/workspaces/${polled.slug}/activity`),
    )
    await vi.waitFor(
      async () =>
        expect(await projectionRunCount(polled.id)).toBeGreaterThan(0),
      { timeout: 3_000 },
    )
    await new Promise((settle) => setTimeout(settle, 500))
    expect(await projectionRunCount(polled.id)).toBe(1)
  })

  it("does not list the workspaces whose activity could not load", async () => {
    await seedWorkspace(failedOrg, readyWorkspace)
    await seedWorkspace(failedOrg, failedWorkspace, {
      projected: true,
      status: "failed",
    })
    const app = workspaceHttpApp(failedOrg, orgActivityRoutes)
    const body = await (await app.request("/workspaces")).json()
    expect(body.status).toBe("ready")
    expect(body).not.toHaveProperty("failedWorkspaces")
    expect(body.pendingWorkspaces).toEqual([])
  })

  it("leaves a deleted workspace out of the org activity", async () => {
    await seedWorkspace(failedOrg, deletedWorkspace, {
      projected: true,
      status: "failed",
    })
    await withOrgIdContext(failedOrg, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: deletedWorkspace.id,
        commits: [commit("9", 0)],
      }),
    )
    await withOrgIdContext(failedOrg, () =>
      deleteWorkspace(deletedWorkspace.slug, deletedWorkspace.slug),
    )
    const app = workspaceHttpApp(failedOrg, orgActivityRoutes)
    const body = await (await app.request("/workspaces")).json()
    expect(JSON.stringify(body)).not.toContain(deletedWorkspace.slug)
    expect(body.recent).toEqual([])
  })
})
