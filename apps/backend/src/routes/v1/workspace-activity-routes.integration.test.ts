import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  insertWorkspaceRepositoryCommits,
  upsertWorkspaceCommitProjection,
} from "../../models/workspace-commits.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceActivityRoutes } from "./workspace-activity-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_activity_${suffix}`,
  slug: `activity-${suffix}`,
  name: "Activity",
}
const workspace = { id: `ws_activity_${suffix}`, slug: `docs-${suffix}` }

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

async function seedWorkspace(
  target: typeof org,
  row: { id: string; slug: string },
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
  // A ready projection with no desired SHA is fresh, so the read enqueues nothing.
  await withOrgIdContext(target, () =>
    upsertWorkspaceCommitProjection({
      workspaceId: row.id,
      headSha: null,
      backfillStatus: "ready",
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
  })

  afterAll(async () => {
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [workspace.id])),
    )
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
})
