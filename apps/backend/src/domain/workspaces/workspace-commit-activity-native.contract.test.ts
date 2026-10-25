import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  insertWorkspaceRepositoryCommits,
  upsertWorkspaceCommitProjection,
} from "../../models/workspace-commits.js"
import { workspaceActivityRoutes } from "../../routes/v1/workspace-activity-routes.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { projectWorkspaceCommits } from "./project-workspace-commits.js"

const COMMIT = {
  sha: "c".repeat(40),
  message: "Add heatmap",
  authorName: "Ada",
  date: "2026-08-26T10:00:00.000Z",
  htmlUrl: `https://github.com/fixture/hydration-contract/commit/${"c".repeat(40)}`,
}

async function projectionRuns(orgId: string, workspaceId: string) {
  const result = await getSystemDb().execute(sql`
    select id
    from openworkflow.workflow_runs
    where workflow_name = 'workspace-commit-projection'
      and input->>'orgId' = ${orgId}
      and input->>'workspaceId' = ${workspaceId}
  `)
  return result.rows
}

it(
  "projects GitHub commits and serves activity from real Postgres rows",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubListCommits: [COMMIT] },
      async (f) => {
        await f.handle.cancel()
        const app = workspaceHttpApp(f.org, workspaceActivityRoutes)

        const pending = await app.request("/workspaces/knowledge/activity")
        expect(pending.status).toBe(200)
        const pendingBody = await pending.json()
        expect(pendingBody.status).toBe("pending")
        expect(pendingBody.recent).toEqual([])
        expect(pendingBody.days.length).toBeGreaterThan(300)
        expect(
          pendingBody.days.every((day: { count: number }) => day.count === 0),
        ).toBe(true)
        await expect
          .poll(
            async () => (await projectionRuns(f.org.id, f.workspaceId)).length,
            {
              timeout: 5_000,
            },
          )
          .toBeGreaterThan(0)

        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "ready" })

        const ready = await app.request("/workspaces/knowledge/activity")
        expect(ready.status).toBe(200)
        const readyBody = await ready.json()
        expect(readyBody.status).toBe("ready")
        expect(readyBody.recent).toEqual([
          {
            sha: COMMIT.sha,
            subject: "Add heatmap",
            authorName: "Ada",
            authorLogin: "Ada",
            committedAt: COMMIT.date,
            htmlUrl: COMMIT.htmlUrl,
            workspaceSlug: "knowledge",
            workspaceName: expect.any(String),
          },
        ])
        expect(
          readyBody.days.find(
            (day: { date: string }) => day.date === "2026-08-26",
          )?.count,
        ).toBe(1)

        const afterReady = (await projectionRuns(f.org.id, f.workspaceId))
          .length
        await app.request("/workspaces/knowledge/activity")
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect((await projectionRuns(f.org.id, f.workspaceId)).length).toBe(
          afterReady,
        )

        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: "d".repeat(40) })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const stale = await app.request("/workspaces/knowledge/activity")
        expect(stale.status).toBe(200)
        expect((await stale.json()).status).toBe("ready")
        await expect
          .poll(
            async () => (await projectionRuns(f.org.id, f.workspaceId)).length,
            {
              timeout: 5_000,
            },
          )
          .toBeGreaterThan(afterReady)
        const afterStale = (await projectionRuns(f.org.id, f.workspaceId))
          .length

        await withOrgIdContext(f.org, () =>
          upsertWorkspaceCommitProjection({
            workspaceId: f.workspaceId,
            headSha: null,
            backfillStatus: "failed",
          }),
        )
        const failed = await app.request("/workspaces/knowledge/activity")
        expect(failed.status).toBe(200)
        expect((await failed.json()).status).toBe("failed")
        await expect
          .poll(
            async () => (await projectionRuns(f.org.id, f.workspaceId)).length,
            {
              timeout: 5_000,
            },
          )
          .toBeGreaterThan(afterStale)
      },
    )
  },
)

it(
  "marks the projection failed when GitHub commit fetch fails",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubListCommits: "fail" },
      async (f) => {
        await f.handle.cancel()
        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "failed" })
        const app = workspaceHttpApp(f.org, workspaceActivityRoutes)
        const response = await app.request("/workspaces/knowledge/activity")
        expect(response.status).toBe(200)
        expect((await response.json()).status).toBe("failed")
      },
    )
  },
)

it(
  "skips a workspace whose GitHub repository no longer exists",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubListCommits: "missing" },
      async (f) => {
        await f.handle.cancel()
        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "ready" })
        const app = workspaceHttpApp(f.org, workspaceActivityRoutes)
        const body = await (
          await app.request("/workspaces/knowledge/activity")
        ).json()
        expect(body.status).toBe("ready")
        expect(body.recent).toEqual([])
      },
    )
  },
)

it(
  "gives empty activity, not an error, for a GitHub repository with no commits",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubListCommits: "empty" },
      async (f) => {
        await f.handle.cancel()
        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "ready" })
        const app = workspaceHttpApp(f.org, workspaceActivityRoutes)
        const body = await (
          await app.request("/workspaces/knowledge/activity")
        ).json()
        expect(body.status).toBe("ready")
        expect(body.recent).toEqual([])
      },
    )
  },
)

it(
  "skips a workspace when GitHub refuses a token for its repository",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubListCommits: [COMMIT] },
      async (f) => {
        await f.handle.cancel()
        f.failTokens(422)
        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "ready" })
      },
    )
  },
)

it(
  "stores the GitHub login of each commit, fills it on old rows, and serves it",
  { timeout: 60_000 },
  async () => {
    const withUser = {
      ...COMMIT,
      sha: "e".repeat(40),
      authorName: "Ada Lovelace",
      authorLogin: "ada-gh",
    }
    const noUser = {
      ...COMMIT,
      sha: "f".repeat(40),
      message: "Import from a mail patch",
      authorName: "Grace",
      authorLogin: null,
      date: "2026-08-25T10:00:00.000Z",
    }
    await withNativeHydrationFixture(
      { github: true, githubListCommits: [withUser, noUser] },
      async (f) => {
        await f.handle.cancel()
        const app = workspaceHttpApp(f.org, workspaceActivityRoutes)
        // A row from before the login column: the next run fills it.
        await withOrgIdContext(f.org, () =>
          insertWorkspaceRepositoryCommits({
            workspaceId: f.workspaceId,
            commits: [
              {
                sha: withUser.sha,
                committedAt: new Date(withUser.date),
                authorName: withUser.authorName,
                subject: withUser.message,
                htmlUrl: withUser.htmlUrl,
              },
            ],
          }),
        )

        expect(
          await withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "ready" })

        const body = await (
          await app.request("/workspaces/knowledge/activity")
        ).json()
        expect(
          body.recent.map(
            (commit: { sha: string; authorLogin?: string | null }) => [
              commit.sha,
              commit.authorLogin,
            ],
          ),
        ).toEqual([
          [withUser.sha, "ada-gh"],
          [noUser.sha, null],
        ])
        // The author menu shows the avatar of each author too.
        expect(body.authors).toEqual([
          { name: "Ada Lovelace", count: 1, login: "ada-gh" },
          { name: "Grace", count: 1, login: null },
        ])
      },
    )
  },
)

it(
  "checks a commit without a GitHub user once, so the next run reads one page",
  { timeout: 60_000 },
  async () => {
    // A full page and one more, all without a GitHub user.
    const commits = Array.from({ length: 101 }, (_, index) => ({
      ...COMMIT,
      sha: index.toString(16).padStart(40, "a"),
      authorName: "Mail patch",
      authorLogin: null,
      date: new Date(Date.UTC(2026, 7, 26, 10) - index * 60_000).toISOString(),
    }))
    let pageReads = 0
    await withNativeHydrationFixture(
      {
        github: true,
        githubListCommits: commits,
        onGithubListCommits: () => {
          pageReads += 1
        },
      },
      async (f) => {
        await f.handle.cancel()
        const project = () =>
          withOrgIdContext(f.org, () =>
            projectWorkspaceCommits({
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          )
        expect(await project()).toEqual({ status: "ready" })
        expect(pageReads).toBe(2)

        // A new head starts the next run. Every stored commit is known.
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: "d".repeat(40) })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(await project()).toEqual({ status: "ready" })
        expect(pageReads).toBe(3)

        const body = await (
          await workspaceHttpApp(f.org, workspaceActivityRoutes).request(
            "/workspaces/knowledge/activity",
          )
        ).json()
        // The API gives null, not "", for a commit without a GitHub user.
        expect(body.recent[0].authorLogin).toBeNull()
        expect(body.authors).toEqual([
          { name: "Mail patch", count: 101, login: null },
        ])
      },
    )
  },
)
