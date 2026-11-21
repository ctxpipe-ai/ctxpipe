import { writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { eq, sql } from "drizzle-orm"
import { http, passthrough } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { orgFeatures } from "../../db/schema/org_features.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../../domain/workspaces/hydrate.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import {
  getKnowledgeState,
  listBranchHeads,
  readyKnowledgeHeads,
} from "../../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { knowledgeProjection } from "./knowledge-projection.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

/*
 * The hydrate workflow queues the projection writer of the knowledge plane
 * after the old projections, only for an org whose flag is not `off`
 * (ADR-069 decision 9). The writer runs as its own workflow, outside the
 * Workspace hydrate lock (ADR-067 decision 3).
 */

let clickhouse: Awaited<ReturnType<typeof startClickHouse>> | undefined
/** The writer user of the worker (ADR-066 decision 9). */
let writerUrl: string

beforeAll(async () => {
  clickhouse = await startClickHouse()
  const adminUrl = await clickhouse.freshDatabase()
  await migrateKnowledgeStore(adminUrl, {
    reader: "reader-test",
    writer: "writer-test",
  })
  writerUrl = userUrl(adminUrl, "ctxpipe_writer", "writer-test")
}, 240_000)

afterAll(async () => {
  await clickhouse?.stop()
})

const files = [
  { path: "a.md", body: "# Alpha\n\nSee [b](b.md) and [missing](c.md).\n" },
  { path: "b.md", body: "# Beta\n" },
]

/** The runs of a workflow for the Workspace. */
async function runsOf(workflowName: string, workspaceId: string) {
  return (
    await getSystemDb().execute(
      sql`select input->>'sha' as sha, status from openworkflow.workflow_runs
        where workflow_name = ${workflowName}
          and input->>'workspaceId' = ${workspaceId}`,
    )
  ).rows as { sha: string | null; status: string }[]
}

/** The document keys that the head of the Workspace shows, with their status. */
async function storedDocuments(f: NativeHydrationFixture) {
  const store = createKnowledgeStore(writerUrl)
  try {
    const state = await getKnowledgeState({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
    })
    if (!state?.branch || state.treeVersion === null) return {}
    return Object.fromEntries(
      (
        await store.listDocumentStatuses({
          orgId: f.org.id,
          heads: [
            {
              workspaceId: f.workspaceId,
              branch: state.branch,
              treeVersion: state.treeVersion,
            },
          ],
        })
      ).map((row) => [row.docKey, row.status]),
    )
  } finally {
    await store.close()
  }
}

/** Wait until the knowledge state of the Workspace matches `expected`. */
async function waitForKnowledgeState(
  f: NativeHydrationFixture,
  expected: Record<string, unknown>,
) {
  await vi.waitFor(
    async () =>
      expect(
        await getKnowledgeState({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        }),
      ).toMatchObject(expected),
    { timeout: 60_000, interval: 200 },
  )
}

/** A URL of the writer user on a local port with no server. */
async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const url = new URL(writerUrl)
  url.hostname = "127.0.0.1"
  url.port = String(address.port)
  return url.toString()
}

it(
  "with the flag `shadow`, the hydrate queues the knowledge projection, which writes the knowledge plane and queues the maintenance job",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      {
        files,
        knowledgePlane: { clickhouseUrl: writerUrl },
      },
      async (f) => {
        await f.publish()
        await waitForKnowledgeState(f, {
          lastSha: f.sha,
          branch: "main",
          treeVersion: 1,
          runStatus: "completed",
          failedCount: 0,
        })
        const keyOf = (path: string) =>
          servingIdForKnowledgePath(f.workspaceId, path)
        expect(await storedDocuments(f)).toEqual({
          [keyOf("a.md")]: "active",
          [keyOf("b.md")]: "active",
          [keyOf("c.md")]: "missing",
        })
        await vi.waitFor(
          async () =>
            expect(
              await runsOf("knowledge-maintenance", f.workspaceId),
            ).toEqual([expect.objectContaining({ sha: f.sha })]),
          { timeout: 30_000, interval: 200 },
        )
      },
    ),
)

it(
  "with ClickHouse down, the hydrate completes on time, the knowledge state keeps `last_sha`, and the knowledge projection catches up when ClickHouse is back",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      {
        files,
        knowledgePlane: { clickhouseUrl: writerUrl },
      },
      async (f) => {
        await f.publish()
        await waitForKnowledgeState(f, {
          lastSha: f.sha,
          runStatus: "completed",
        })

        // A new commit while ClickHouse is down: the worker gets no
        // connection.
        const down = await closedPortUrl()
        f.server.use(http.all(`${new URL(down).origin}/*`, () => passthrough()))
        f.git("checkout", "--", ".")
        writeFileSync(join(f.directory, "d.md"), "# Delta\n")
        f.git("add", "-A")
        f.git("commit", "-q", "-m", "Add d")
        f.git("push", "-q", f.remote, "HEAD:refs/heads/main")
        const tip = f.git("rev-parse", "HEAD")
        const revision = await f.resolveRevision(true)
        expect(revision.sha).toBe(tip)
        // The fixture cleanup restores the variable, also after a failure.
        process.env.CLICKHOUSE_URL = down

        // The old stack does not wait for the knowledge plane: the hydrate
        // completes in much less time than the retries of the writer.
        const handle = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision,
        })
        expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
          hydrated: true,
        })

        // The writer throws, and the state keeps `last_sha`.
        await waitForKnowledgeState(f, {
          lastSha: f.sha,
          treeVersion: 1,
          runStatus: "failed",
        })
        // The run of the new tip did not end: it waits for its next attempt.
        expect(
          (await runsOf("knowledge-projection", f.workspaceId)).filter(
            (run) => run.status !== "completed",
          ),
        ).toHaveLength(1)

        // ClickHouse is back: the retry of the step applies the tip.
        process.env.CLICKHOUSE_URL = writerUrl
        await waitForKnowledgeState(f, {
          lastSha: tip,
          treeVersion: 2,
          runStatus: "completed",
        })
        expect(await storedDocuments(f)).toMatchObject({
          [servingIdForKnowledgePath(f.workspaceId, "d.md")]: "active",
        })
      },
    ),
)

it(
  "with no flag (`off`), the hydrate writes only the old stack",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      expect(
        await getKnowledgeState({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        }),
      ).toBeNull()
      expect(await runsOf("knowledge-projection", f.workspaceId)).toEqual([])
      expect(await runsOf("knowledge-maintenance", f.workspaceId)).toEqual([])
    }),
)

it(
  "a queued knowledge projection of an org whose flag is now `off` writes nothing",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await f.publish()
        await waitForKnowledgeState(f, { lastSha: f.sha })
        f.git("checkout", "--", ".")
        writeFileSync(join(f.directory, "d.md"), "# Delta\n")
        f.git("add", "-A")
        f.git("commit", "-q", "-m", "Add d")
        f.git("push", "-q", f.remote, "HEAD:refs/heads/main")
        await f.resolveRevision(true)
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(orgFeatures)
            .set({ value: "off" })
            .where(eq(orgFeatures.organizationId, f.org.id)),
        )
        const handle = await f.runner.runWorkflow(knowledgeProjection.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        })
        expect(await handle.result({ timeoutMs: 60_000 })).toBeNull()
        expect(
          await getKnowledgeState({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
          }),
        ).toMatchObject({ lastSha: f.sha, runStatus: "completed" })
        expect(await storedDocuments(f)).not.toHaveProperty(
          servingIdForKnowledgePath(f.workspaceId, "d.md"),
        )
      },
    ),
)

it(
  "a run of a branch makes its overlay and queues no maintenance; when Git deletes the branch, the next run removes its head",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await f.publish()
        await waitForKnowledgeState(f, { lastSha: f.sha })
        const maintenance = (
          await runsOf("knowledge-maintenance", f.workspaceId)
        ).length
        f.git("checkout", "--", ".")
        f.git("checkout", "-q", "-b", "feature")
        writeFileSync(join(f.directory, "b.md"), "# Beta on the branch\n")
        f.git("add", "-A")
        f.git("commit", "-q", "-m", "Add b on the branch")
        f.git("push", "-q", f.remote, "HEAD:refs/heads/feature")
        const key = { orgId: f.org.id, workspaceId: f.workspaceId }
        const handle = await f.runner.runWorkflow(knowledgeProjection.spec, {
          ...key,
          branch: "feature",
        })
        expect(await handle.result({ timeoutMs: 90_000 })).toMatchObject({
          isDefault: false,
          summary: { mode: "overlay" },
        })
        expect(
          (await readyKnowledgeHeads(f.org.id, [f.workspaceId], "feature")).get(
            f.workspaceId,
          ),
        ).toMatchObject({ branch: "feature", base: { sha: f.sha } })
        // ADR-071 decision 9: no maintenance for a branch.
        expect(
          await runsOf("knowledge-maintenance", f.workspaceId),
        ).toHaveLength(maintenance)

        f.git("push", "-q", f.remote, ":refs/heads/feature")
        const deleted = await f.runner.runWorkflow(knowledgeProjection.spec, {
          ...key,
          branch: "feature",
        })
        expect(await deleted.result({ timeoutMs: 90_000 })).toMatchObject({
          summary: { mode: "deleted" },
        })
        expect(
          await readyKnowledgeHeads(f.org.id, [f.workspaceId], "feature"),
        ).toEqual(new Map())
      },
    ),
)

it(
  "a rename of the default branch: reads stay on the earlier tree until the new default branch has its tree; it then queues each other branch, and the earlier default branch leaves when Git deletes it",
  { timeout: 240_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await f.publish()
        await waitForKnowledgeState(f, { lastSha: f.sha })
        const key = { orgId: f.org.id, workspaceId: f.workspaceId }
        const defaultHead = async () =>
          (await readyKnowledgeHeads(f.org.id, [f.workspaceId])).get(
            f.workspaceId,
          )
        f.git("checkout", "--", ".")
        f.git("checkout", "-q", "-b", "feature")
        writeFileSync(join(f.directory, "b.md"), "# Beta on the branch\n")
        f.git("add", "-A")
        f.git("commit", "-q", "-m", "Add b on the branch")
        f.git("push", "-q", f.remote, "HEAD:refs/heads/feature")
        await (
          await f.runner.runWorkflow(knowledgeProjection.spec, {
            ...key,
            branch: "feature",
          })
        ).result({ timeoutMs: 90_000 })

        // The rename: `trunk` at the tip of main, and the setting names it.
        f.git("push", "-q", f.remote, "main:refs/heads/trunk")
        f.git("--git-dir", f.remote, "symbolic-ref", "HEAD", "refs/heads/trunk")
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({ desiredDefaultBranch: "trunk" })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect((await defaultHead())?.branch).toBe("main")
        const renamed = await f.runner.runWorkflow(
          knowledgeProjection.spec,
          key,
        )
        const result = (await renamed.result({ timeoutMs: 90_000 })) as {
          isDefault: boolean
          others: string[]
        }
        expect(result.isDefault).toBe(true)
        expect([...result.others].sort()).toEqual(["feature", "main"])
        expect(await defaultHead()).toMatchObject({
          branch: "trunk",
          sha: f.sha,
        })
        // The queued runs of the other branches end: the overlay of feature
        // now has trunk as its base.
        await vi.waitFor(
          async () =>
            expect(
              (await runsOf("knowledge-projection", f.workspaceId)).every(
                (run) => run.status === "completed",
              ),
            ).toBe(true),
          { timeout: 150_000, interval: 1_000 },
        )
        expect(
          (await readyKnowledgeHeads(f.org.id, [f.workspaceId], "feature")).get(
            f.workspaceId,
          ),
        ).toMatchObject({ base: { branch: "trunk" } })
        // Git deletes main: its run removes its head.
        f.git("push", "-q", f.remote, ":refs/heads/main")
        const gone = await f.runner.runWorkflow(knowledgeProjection.spec, {
          ...key,
          branch: "main",
        })
        expect(await gone.result({ timeoutMs: 90_000 })).toMatchObject({
          summary: { mode: "deleted" },
        })
        expect(
          await readyKnowledgeHeads(f.org.id, [f.workspaceId], "main"),
        ).toEqual(new Map())
        expect(
          (await listBranchHeads(key)).map((row) => row.branch).sort(),
        ).toEqual(["feature", "trunk"])
      },
    ),
)
