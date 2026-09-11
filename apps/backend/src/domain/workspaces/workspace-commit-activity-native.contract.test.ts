import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { upsertWorkspaceCommitProjection } from "../../models/workspace-commits.js"
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
          .poll(async () => (await projectionRuns(f.org.id, f.workspaceId)).length, {
            timeout: 5_000,
          })
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
            committedAt: COMMIT.date,
            htmlUrl: COMMIT.htmlUrl,
          },
        ])
        expect(
          readyBody.days.find((day: { date: string }) => day.date === "2026-08-26")
            ?.count,
        ).toBe(1)

        const afterReady = (await projectionRuns(f.org.id, f.workspaceId)).length
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
          .poll(async () => (await projectionRuns(f.org.id, f.workspaceId)).length, {
            timeout: 5_000,
          })
          .toBeGreaterThan(afterReady)
        const afterStale = (await projectionRuns(f.org.id, f.workspaceId)).length

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
          .poll(async () => (await projectionRuns(f.org.id, f.workspaceId)).length, {
            timeout: 5_000,
          })
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
