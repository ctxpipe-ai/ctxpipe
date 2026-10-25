import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { WRITE_STATUS_REASONS } from "../../domain/workspaces/write-status.js"
import {
  insertWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  getWorkspaceById,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { insertLinkedRepositoryRows } from "../../test/workspace-links-fixture.js"
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
      // The upgrades API owns the upgrade state (ADR-053). The Workspace
      // shape has no second, different answer.
      for (const item of listedBody.items)
        expect(item).not.toHaveProperty("upgradeNeeded")

      const missing = await app.request("/workspaces/missing")
      expect(missing.status).toBe(404)

      await withOrgDbContext(f.org.id, (db) =>
        insertLinkedRepositoryRows(db, {
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

async function tipCheckKeys(orgId: string) {
  const result = await getSystemDb().execute(sql`
    select idempotency_key
    from openworkflow.workflow_runs
    where input->>'orgId' = ${orgId}
      and workflow_name = 'workspace-tip-check'
    order by created_at
  `)
  return (result.rows as Array<{ idempotency_key: string | null }>).map(
    (row) => row.idempotency_key,
  )
}

it(
  "re-checks write access once a minute when Workspace detail is read with an unknown write status",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "unknown" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const before = await tipCheckKeys(f.org.id)
      // Pin the clock so the three reads share one minute. The route makes
      // the key before it returns, so the pin covers each key.
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now())
      const minute = Math.floor(Date.now() / 60_000)
      try {
        for (let i = 0; i < 3; i++) {
          const detail = await app.request("/workspaces/knowledge")
          expect(detail.status).toBe(200)
          expect(await detail.json()).toMatchObject({ writeStatus: "unknown" })
        }
      } finally {
        now.mockRestore()
      }

      // Each enqueue uses the same key, so the queue keeps one run for it.
      await expect
        .poll(async () => (await tipCheckKeys(f.org.id)).slice(before.length), {
          timeout: 5_000,
        })
        .toEqual([`tip-check-on-demand:${f.org.id}:${minute}`])
    })
  },
)

it(
  "queues one idempotent re-check per minute on Workspace detail reads with a read_only write status",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "read_only" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const before = await tipCheckKeys(f.org.id)
      // Pin the clock so both reads share one minute.
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now())
      const minute = Math.floor(Date.now() / 60_000)
      try {
        for (let i = 0; i < 2; i++) {
          const detail = await app.request("/workspaces/knowledge")
          expect(detail.status).toBe(200)
        }
      } finally {
        now.mockRestore()
      }

      await expect
        .poll(async () => (await tipCheckKeys(f.org.id)).slice(before.length), {
          timeout: 5_000,
        })
        .toEqual([`tip-check-on-demand:${f.org.id}:${minute}`])
    })
  },
)

it(
  "queues a new re-check with a new key when a read_only Workspace is read in the next minute",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "read_only" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const before = await tipCheckKeys(f.org.id)
      const start = Math.floor(Date.now() / 60_000) * 60_000
      const now = vi.spyOn(Date, "now")
      try {
        for (const at of [start, start + 60_000]) {
          now.mockReturnValue(at)
          expect((await app.request("/workspaces/knowledge")).status).toBe(200)
        }
      } finally {
        now.mockRestore()
      }

      const minute = start / 60_000
      await expect
        .poll(async () => (await tipCheckKeys(f.org.id)).slice(before.length), {
          timeout: 5_000,
        })
        .toEqual([
          `tip-check-on-demand:${f.org.id}:${minute}`,
          `tip-check-on-demand:${f.org.id}:${minute + 1}`,
        ])
    })
  },
)

it(
  "queues the on-demand re-check when Workspace detail is read with a pr_open upgrade row, and not with an awaiting_operator row",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "writable" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const upgrade = { key: "format-3", fromFormat: 2, targetFormat: 3 }
      await withOrgIdContext(f.org, () =>
        insertWorkspaceUpgradeRow({
          workspaceId: f.workspaceId,
          generation: 3,
          status: "awaiting_operator",
          upgrade,
        }),
      )
      const backend = await BackendPostgres.connect(f.databaseUrl, {
        namespaceId: openWorkflowNamespaceId(),
        runMigrations: false,
      })
      const tipChecks = async () =>
        (await backend.listWorkflowRuns({ limit: 100 })).data
          .filter(
            (run) =>
              run.workflowName === "workspace-tip-check" &&
              (run.input as { orgId?: string })?.orgId === f.org.id,
          )
          .map((run) => run.idempotencyKey)
      // Pin the date, so that the key does not depend on the wall clock.
      const minute = 30_000_000
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        // A writable Workspace with an upgrade that waits for an operator
        // needs no probe.
        vi.setSystemTime(minute * 60_000)
        expect((await app.request("/workspaces/knowledge")).status).toBe(200)

        // The merge may have happened without a webhook. A visit probes.
        await withOrgIdContext(f.org, () =>
          transitionWorkspaceUpgradeRow({
            workspaceId: f.workspaceId,
            key: upgrade.key,
            from: ["awaiting_operator"],
            to: "pr_open",
          }),
        )
        vi.setSystemTime((minute + 1) * 60_000)
        expect((await app.request("/workspaces/knowledge")).status).toBe(200)
      } finally {
        vi.useRealTimers()
      }

      try {
        await expect
          .poll(async () => (await tipChecks()).length, { timeout: 5_000 })
          .toBeGreaterThan(0)
        expect(await tipChecks()).toEqual([
          `tip-check-on-demand:${f.org.id}:${minute + 1}`,
        ])
      } finally {
        await backend.stop()
      }
    })
  },
)

it(
  "refuses the check-again route for a caller that is not an org admin, and queues no tip check",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      const before = (await workflowNames(f.org.id, f.workspaceId)).filter(
        (name) => name === "workspace-tip-check",
      ).length
      // The test session has no org member role, so the admin gate refuses it.
      const res = await app.request("/workspaces/knowledge/upgrades/check", {
        method: "POST",
      })
      expect(res.status).toBe(403)
      expect(
        (await workflowNames(f.org.id, f.workspaceId)).filter(
          (name) => name === "workspace-tip-check",
        ).length,
      ).toBe(before)
    })
  },
)

it(
  "reports a legacy projection graph as ready so the graph route decides",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      const phases = async () =>
        (
          (await (await app.request("/workspaces/knowledge")).json()) as {
            hydratePhases?: { graph: unknown }
          }
        ).hydratePhases?.graph
      const legacy = {
        activeRevision: null,
        activeProjectionSha: "a".repeat(40),
        activeProjectionUrl: "https://github.com/acme/knowledge",
      }
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ ...legacy, hydrateStatus: "ready" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      expect(await phases()).toEqual({ kind: "ready" })
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ ...legacy, hydrateStatus: "failed", hydrateError: "boom" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      expect(await phases()).toEqual({ kind: "ready" })
    })
  },
)

it(
  "resolves a failed write-access check, then a retry checks again until GitHub answers",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const app = workspaceHttpApp(f.org, workspaceRoutes)
        const writeState = async () => {
          const detail = await app.request("/workspaces/knowledge")
          expect(detail.status).toBe(200)
          const body = (await detail.json()) as {
            writeStatus: string
            readOnlyReason: string | null
          }
          return {
            writeStatus: body.writeStatus,
            readOnlyReason: body.readOnlyReason,
          }
        }
        const runTipCheck = async () => {
          const handle = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await handle.result({ timeoutMs: 30_000 })
        }

        f.server.use(
          http.get("https://api.github.com/repos/fixture/:repo", () =>
            HttpResponse.json(
              { message: "API rate limit exceeded for installation ID 1." },
              { status: 403, headers: { "x-ratelimit-remaining": "0" } },
            ),
          ),
        )
        await runTipCheck()
        expect(await writeState()).toEqual({
          writeStatus: "unknown",
          readOnlyReason: WRITE_STATUS_REASONS.checkFailed,
        })

        f.server.resetHandlers()
        const before = await tipCheckKeys(f.org.id)
        const retried = await app.request(
          "/workspaces/knowledge/check-write-access",
          { method: "POST" },
        )
        expect(retried.status).toBe(200)
        expect(await retried.json()).toMatchObject({
          writeStatus: "unknown",
          readOnlyReason: null,
        })
        expect((await tipCheckKeys(f.org.id)).slice(before.length)).toEqual([
          expect.stringMatching(/^tip-check-on-demand:/),
        ])

        await runTipCheck()
        expect(await writeState()).toEqual({
          writeStatus: "writable",
          readOnlyReason: null,
        })
      },
    )
  },
)

it(
  "does not re-check on a read of a failed check, and a retry in the same minute starts no second run",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      const failed = async () =>
        withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({
              writeStatus: "unknown",
              readOnlyReason: WRITE_STATUS_REASONS.checkFailed,
            })
            .where(eq(workspaces.id, f.workspaceId)),
        )
      await failed()
      const before = await tipCheckKeys(f.org.id)
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now())
      try {
        for (let i = 0; i < 2; i++) {
          const detail = await app.request("/workspaces/knowledge")
          expect(await detail.json()).toMatchObject({
            readOnlyReason: WRITE_STATUS_REASONS.checkFailed,
          })
        }
        expect((await tipCheckKeys(f.org.id)).slice(before.length)).toEqual([])

        const first = await app.request(
          "/workspaces/knowledge/check-write-access",
          { method: "POST" },
        )
        expect(await first.json()).toMatchObject({ readOnlyReason: null })

        // The run ends. A second failure and retry in the same minute starts
        // no run, so the row keeps its reason.
        await getSystemDb().execute(sql`
          update openworkflow.workflow_runs
          set status = 'completed'
          where input->>'orgId' = ${f.org.id}
            and workflow_name = 'workspace-tip-check'
        `)
        await failed()
        const second = await app.request(
          "/workspaces/knowledge/check-write-access",
          { method: "POST" },
        )
        expect(await second.json()).toMatchObject({
          readOnlyReason: WRITE_STATUS_REASONS.checkFailed,
        })
      } finally {
        now.mockRestore()
      }
      expect((await tipCheckKeys(f.org.id)).slice(before.length)).toHaveLength(
        1,
      )
    })
  },
)
