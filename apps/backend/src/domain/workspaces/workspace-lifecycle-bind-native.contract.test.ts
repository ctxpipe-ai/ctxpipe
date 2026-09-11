import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { workspaceRoutes } from "../../routes/v1/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"
import { relinkWorkspaceLifecycle } from "./workspace-lifecycle.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

async function orgWorkflows(orgId: string) {
  const result = await getSystemDb().execute(sql`
    select workflow_name, input
    from openworkflow.workflow_runs
    where input->>'orgId' = ${orgId}
  `)
  return result.rows as Array<{
    workflow_name: string
    input: { workspaceId?: string }
  }>
}

function relinkCounts(
  rows: Awaited<ReturnType<typeof orgWorkflows>>,
  workspaceId: string,
) {
  return {
    hydrate: rows.filter(
      (row) =>
        row.workflow_name === "workspace-hydrate" &&
        row.input.workspaceId === workspaceId,
    ).length,
    bootstrap: rows.filter(
      (row) =>
        row.workflow_name === "workspace-write-bootstrap" &&
        row.input.workspaceId === workspaceId,
    ).length,
    tipCheck: rows.filter((row) => row.workflow_name === "workspace-tip-check")
      .length,
  }
}

it(
  "relinks only when the canonical URL changes and binds Select vs Paste from real connections",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const currentUrl = normalizeWorkspaceRepositoryUrl(f.workspaceUrl)
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ workspaceRepositoryUrl: currentUrl })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const errors: string[] = []
      const log = {
        error: (error: Error) => {
          errors.push(error.message)
        },
      }
      const before = relinkCounts(
        await orgWorkflows(f.org.id),
        f.workspaceId,
      )
      const current = await withOrgIdContext(f.org, () =>
        getWorkspaceById(f.workspaceId),
      )
      if (!current) throw new Error("Fixture workspace missing")

      const unchanged = await withOrgIdContext(f.org, () =>
        relinkWorkspaceLifecycle({
          slug: "knowledge",
          current,
          orgId: f.org.id,
          workspaceRepositoryUrl: `${currentUrl}.git`,
          persistConnection: false,
          bindingSubmitted: true,
          log,
        }),
      )
      expect(unchanged.changed).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(relinkCounts(await orgWorkflows(f.org.id), f.workspaceId)).toEqual(
        before,
      )

      const otherRemote = join(f.directory, "other.git")
      execFileSync("git", ["clone", "--bare", f.remote, otherRemote])
      const changed = await withOrgIdContext(f.org, () =>
        relinkWorkspaceLifecycle({
          slug: "knowledge",
          current: unchanged.workspace ?? current,
          orgId: f.org.id,
          workspaceRepositoryUrl: `file://${otherRemote}`,
          persistConnection: false,
          bindingSubmitted: true,
          log,
        }),
      )
      expect(changed.changed).toBe(true)
      await expect
        .poll(
          async () => relinkCounts(await orgWorkflows(f.org.id), f.workspaceId),
          { timeout: 5_000 },
        )
        .toMatchObject({
          tipCheck: before.tipCheck + 1,
        })
      const relinked = await withOrgIdContext(f.org, () =>
        getWorkspaceById(f.workspaceId),
      )
      expect(relinked?.workspaceRepositoryUrl).toBe(
        normalizeWorkspaceRepositoryUrl(`file://${otherRemote}`),
      )
      expect(relinked?.slug).toBe("knowledge")

      const app = workspaceHttpApp(f.org, workspaceRoutes)
      const select = await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/fixture/select-bind.git",
          source: "select",
        }),
      })
      expect(select.status).toBe(201)
      expect(await select.json()).toMatchObject({
        slug: "select-bind",
        githubConnectionId: f.connectionId,
        writeStatus: "unknown",
        readOnlyReason: null,
      })

      const paste = await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/fixture/paste-bind.git",
          source: "paste",
        }),
      })
      expect(paste.status).toBe(201)
      expect(await paste.json()).toMatchObject({
        slug: "paste-bind",
        githubConnectionId: null,
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
      })

      const foreign = await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/fixture/foreign-bind.git",
          githubConnectionId: "con_other",
          source: "select",
        }),
      })
      expect(foreign.status).toBe(201)
      expect(await foreign.json()).toMatchObject({
        slug: "foreign-bind",
        githubConnectionId: null,
        writeStatus: "read_only",
        readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
      })

      const explicit = await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/fixture/explicit-bind.git",
          githubConnectionId: f.connectionId,
        }),
      })
      expect(explicit.status).toBe(201)
      expect(await explicit.json()).toMatchObject({
        slug: "explicit-bind",
        githubConnectionId: f.connectionId,
        writeStatus: "unknown",
      })
    })
  },
)
