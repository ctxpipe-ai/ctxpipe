import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import {
  orgActivityRoutes,
  workspaceActivityRoutes,
} from "./workspace-activity-routes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `org_test_activity_list_${suffix}`,
  slug: `activity-list-${suffix}`,
  name: "Activity list",
}
const docs = { id: `ws_activity_list_docs_${suffix}`, slug: `docs-${suffix}` }
const wiki = { id: `ws_activity_list_wiki_${suffix}`, slug: `wiki-${suffix}` }

const DAY_MS = 86_400_000
// Three UTC days before today, at midnight.
const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS
const dayKey = (offsetDays: number) =>
  new Date(dayStart + offsetDays * DAY_MS).toISOString().slice(0, 10)

function commit(
  sha: string,
  offsetMs: number,
  authorName: string,
): {
  sha: string
  committedAt: Date
  authorName: string
  subject: string
  htmlUrl: null
} {
  return {
    sha: sha.repeat(40),
    committedAt: new Date(dayStart + offsetMs),
    authorName,
    subject: `Commit ${sha}`,
    htmlUrl: null,
  }
}

type Body = {
  recent: { subject: string; workspaceSlug: string }[]
  nextCursor: string | null
  authors: { name: string; count: number }[]
}

async function read(
  app: { request: (path: string) => Response | Promise<Response> },
  path: string,
): Promise<Body> {
  const res = await app.request(path)
  expect(res.status).toBe(200)
  return (await res.json()) as Body
}

/** Follows `nextCursor` from the first page to the last. */
async function readAllPages(
  app: { request: (path: string) => Response | Promise<Response> },
  path: string,
): Promise<{ subjects: string[]; pages: number }> {
  const subjects: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const join = path.includes("?") ? "&" : "?"
    const body = await read(
      app,
      cursor ? `${path}${join}cursor=${encodeURIComponent(cursor)}` : path,
    )
    subjects.push(...body.recent.map((row) => row.subject))
    cursor = body.nextCursor
    pages += 1
  } while (cursor && pages < 20)
  return { subjects, pages }
}

async function seedWorkspace(row: { id: string; slug: string }) {
  await withOrgDbContext(org.id, (db) =>
    db.insert(workspaces).values({
      id: row.id,
      orgId: org.id,
      slug: row.slug,
      displayName: row.slug,
      workspaceRepositoryUrl: `https://github.com/example/${row.slug}.git`,
    }),
  )
  // A ready projection with no desired SHA is fresh, so a read enqueues nothing.
  await withOrgIdContext(org, () =>
    upsertWorkspaceCommitProjection({
      workspaceId: row.id,
      headSha: null,
      backfillStatus: "ready",
    }),
  )
}

describe("workspace activity list filters and pages (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
    await seedWorkspace(docs)
    await seedWorkspace(wiki)
    await withOrgIdContext(org, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: docs.id,
        commits: [
          commit("a", 1_000, "Ada"),
          commit("b", 2_000, "Lin"),
          // c and d have the same time; the SHA orders them.
          commit("c", DAY_MS + 3_000, "Ada"),
          commit("d", DAY_MS + 3_000, "Ada"),
          commit("e", 2 * DAY_MS + 4_000, "Lin"),
        ],
      }),
    )
    await withOrgIdContext(org, () =>
      insertWorkspaceRepositoryCommits({
        workspaceId: wiki.id,
        // The same SHA and time as docs commit c: the workspace id orders them.
        commits: [commit("c", DAY_MS + 3_000, "Ada"), commit("f", 5, "Grace")],
      }),
    )
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${org.id}`,
    )
    await withOrgDbContext(org.id, (db) =>
      db.delete(workspaces).where(inArray(workspaces.id, [docs.id, wiki.id])),
    )
    // The routes import the OpenWorkflow client, which connects on import.
    const { closeOpenWorkflowClient } =
      await import("../../openworkflow/client.js")
    await closeOpenWorkflowClient()
    await closeDb()
  })

  it("pages one workspace with the cursor, with no row twice or missing", async () => {
    const app = workspaceHttpApp(org, workspaceActivityRoutes)
    const path = `/workspaces/${docs.slug}/activity`
    const first = await read(app, `${path}?limit=2`)
    expect(first.recent.map((row) => row.subject)).toEqual([
      "Commit e",
      "Commit c",
    ])
    expect(first.nextCursor).toEqual(expect.any(String))

    const all = await readAllPages(app, `${path}?limit=2`)
    expect(all.subjects).toEqual([
      "Commit e",
      "Commit c",
      "Commit d",
      "Commit b",
      "Commit a",
    ])
    expect(all.pages).toBe(3)

    // The default page stays 5 rows, and says that no more rows exist.
    const legacy = await read(app, path)
    expect(legacy.recent).toHaveLength(5)
    expect(legacy.nextCursor).toBeNull()
  })

  it("pages every workspace of the org, also through rows with the same time and SHA", async () => {
    const app = workspaceHttpApp(org, orgActivityRoutes)
    const all = await readAllPages(app, "/workspaces?limit=1")
    expect(all.subjects).toEqual([
      "Commit e",
      "Commit c",
      "Commit c",
      "Commit d",
      "Commit b",
      "Commit a",
      "Commit f",
    ])
    expect(all.pages).toBe(7)
  })

  it("filters by author and by date range on one workspace", async () => {
    const app = workspaceHttpApp(org, workspaceActivityRoutes)
    const path = `/workspaces/${docs.slug}/activity`
    const ada = await read(app, `${path}?author=Ada&limit=20`)
    expect(ada.recent.map((row) => row.subject)).toEqual([
      "Commit c",
      "Commit d",
      "Commit a",
    ])
    // The authors list stays the full list when the author filter is set.
    expect(ada.authors).toEqual([
      { name: "Ada", count: 3, login: null },
      { name: "Lin", count: 2, login: null },
    ])

    const range = await read(
      app,
      `${path}?since=${dayKey(1)}&until=${dayKey(2)}&limit=20`,
    )
    expect(range.recent.map((row) => row.subject)).toEqual([
      "Commit e",
      "Commit c",
      "Commit d",
    ])

    const both = await read(
      app,
      `${path}?author=Lin&since=${dayKey(0)}&until=${dayKey(1)}`,
    )
    expect(both.recent.map((row) => row.subject)).toEqual(["Commit b"])

    // The heatmap day and the author filter apply together.
    const day = await read(app, `${path}?date=${dayKey(1)}&author=Lin`)
    expect(day.recent).toEqual([])
  })

  it("filters by author and by date range on every workspace of the org", async () => {
    const app = workspaceHttpApp(org, orgActivityRoutes)
    const ada = await readAllPages(app, "/workspaces?author=Ada&limit=2")
    expect(ada.subjects).toEqual([
      "Commit c",
      "Commit c",
      "Commit d",
      "Commit a",
    ])

    const range = await read(
      app,
      `/workspaces?since=${dayKey(0)}&until=${dayKey(0)}&limit=20`,
    )
    expect(
      range.recent.map((row) => `${row.workspaceSlug}/${row.subject}`),
    ).toEqual([
      `${docs.slug}/Commit b`,
      `${docs.slug}/Commit a`,
      `${wiki.slug}/Commit f`,
    ])
    expect(range.authors).toEqual([
      { name: "Ada", count: 4, login: null },
      { name: "Lin", count: 2, login: null },
      { name: "Grace", count: 1, login: null },
    ])
  })

  it("rejects a bad cursor, limit, or range day", async () => {
    const app = workspaceHttpApp(org, orgActivityRoutes)
    for (const query of [
      "cursor=not-a-cursor",
      "limit=0",
      "limit=101",
      "since=2026-13-01",
      "until=yesterday",
    ]) {
      expect((await app.request(`/workspaces?${query}`)).status).toBe(400)
    }
  })
})
