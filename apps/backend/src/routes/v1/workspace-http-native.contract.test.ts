import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  getWorkspaceById,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

async function workflowNames(orgId: string, workspaceId: string) {
  const result = await getSystemDb().execute(sql`
    select workflow_name
    from openworkflow.workflow_runs
    where input->>'orgId' = ${orgId}
      and (
        input->>'workspaceId' = ${workspaceId}
        or workflow_name = 'workspace-tip-check'
      )
  `)
  return (result.rows as Array<{ workflow_name: string }>).map(
    (row) => row.workflow_name,
  )
}

it(
  "serves Workspace HTTP list, detail, touch, retry, and delete from real rows",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)

      const listed = await app.request("/workspaces")
      expect(listed.status).toBe(200)
      const listedBody = await listed.json()
      expect(listedBody.lastUsedWorkspaceId).toBeNull()
      expect(listedBody.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: f.workspaceId,
            slug: "knowledge",
          }),
        ]),
      )

      const missing = await app.request("/workspaces/missing")
      expect(missing.status).toBe(404)

      await withOrgDbContext(f.org.id, (db) =>
        db.insert(workspaceLinkedRepositories).values({
          id: `wlr_${f.id}`,
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          gitUrl: "https://github.com/acme/app",
        }),
      )
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({
            hydrateStatus: "failed",
            hydrateError: "getLogger: no logger in context.",
            writeStatus: "read_only",
          })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const beforeTip = (await workflowNames(f.org.id, f.workspaceId)).filter(
        (name) => name === "workspace-tip-check",
      ).length
      const detail = await app.request("/workspaces/knowledge")
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        slug: "knowledge",
        hydrateStatus: "failed",
        hydrateError: "getLogger: no logger in context.",
        linkedRepositories: [
          expect.objectContaining({ gitUrl: "https://github.com/acme/app" }),
        ],
      })
      await expect
        .poll(
          async () =>
            (await workflowNames(f.org.id, f.workspaceId)).filter(
              (name) => name === "workspace-tip-check",
            ).length,
          { timeout: 5_000 },
        )
        .toBeGreaterThan(beforeTip)

      const touched = await app.request("/workspaces/knowledge/touch", {
        method: "POST",
      })
      expect(touched.status).toBe(204)
      const afterTouch = await app.request("/workspaces")
      expect((await afterTouch.json()).lastUsedWorkspaceId).toBe(f.workspaceId)

      const retried = await app.request("/workspaces/knowledge/retry-prepare", {
        method: "POST",
      })
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({
        hydrateStatus: "pending",
        hydrateError: null,
      })
      await expect
        .poll(
          async () =>
            (await workflowNames(f.org.id, f.workspaceId)).includes(
              "workspace-hydrate",
            ),
          { timeout: 5_000 },
        )
        .toBe(true)

      const confirmMismatch = await app.request("/workspaces/knowledge", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: "wrong" }),
      })
      expect(confirmMismatch.status).toBe(400)
      expect(await confirmMismatch.json()).toEqual({
        error: "Type the Workspace display name to confirm delete",
      })

      const deleteMissing = await app.request("/workspaces/missing", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: "Docs" }),
      })
      expect(deleteMissing.status).toBe(404)

      await withOrgIdContext(f.org, () =>
        persistSandboxInstance({
          id: `job_${f.id}`,
          kind: "job",
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          provider: "unknown",
          providerSandboxId: "sbx_live",
          state: "live",
          lastHeartbeatAt: new Date(),
        }),
      )
      const leftover = await app.request("/workspaces/knowledge", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: "Hydration contract" }),
      })
      expect([409, 500]).toContain(leftover.status)
      expect(leftover.status).not.toBe(204)
      expect(
        await withOrgIdContext(f.org, () => getWorkspaceById(f.workspaceId)),
      ).toMatchObject({ id: f.workspaceId })
    })
  },
)
