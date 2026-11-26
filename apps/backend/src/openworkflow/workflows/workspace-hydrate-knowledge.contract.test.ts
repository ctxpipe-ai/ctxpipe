import { writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { eq, sql } from "drizzle-orm"
import { http, passthrough } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../../db/schema/workspaces.js"
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
 * after the old projections, for each org (ADR-069 decision 9, CTX-1712). The writer runs as its own workflow, outside the
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
    // The head that a read of the default branch uses.
    const head = (await readyKnowledgeHeads(f.org.id, [f.workspaceId])).get(
      f.workspaceId,
    )
    if (!head) return {}
    return Object.fromEntries(
      (
        await store.listDocumentStatuses({
          orgId: f.org.id,
          heads: [{ workspaceId: f.workspaceId, ...head }],
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
  "the hydrate queues the knowledge projection, which writes the knowledge plane and queues the maintenance job",
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
  "a NUL character in a mirrored issue body does not fail the hydrate: Postgres and the knowledge plane keep the text without it (CTX-1521)",
  { timeout: 120_000 },
  async () => {
    // A made-up issue that quotes a Git protocol error, which holds NUL
    // characters as the error text of Git does.
    const path = "github/issues/acme/widgets/7.md"
    const quote =
      "000eunpack ok\u00000019ok refs/heads/main\u0000capabilities^{}\u0000report-status\u0000"
    const body = `---\nsource: github\ntype: issue\nnumber: 7\n---\n# Push fails \u0000with a protocol error\n\nThe server says:\n\n    ${quote}\n`
    await withNativeHydrationFixture(
      {
        files: [...files, { path, body }],
        knowledgePlane: { clickhouseUrl: writerUrl },
      },
      async (f) => {
        await f.publish()
        const servingId = servingIdForKnowledgePath(f.workspaceId, path)
        const { unit, chunks } = await withOrgDbContext(
          f.org.id,
          async (db) => ({
            unit: (
              await db
                .select({
                  title: workspaceKnowledgeUnits.title,
                  body: workspaceKnowledgeUnits.body,
                })
                .from(workspaceKnowledgeUnits)
                .where(eq(workspaceKnowledgeUnits.servingId, servingId))
            )[0],
            chunks: await db
              .select({ text: workspaceKnowledgeChunks.text })
              .from(workspaceKnowledgeChunks)
              .where(eq(workspaceKnowledgeChunks.unitId, servingId)),
          }),
        )
        expect(unit?.title).toBe("Push fails with a protocol error")
        expect(unit?.body).toContain(quote.replaceAll("\u0000", ""))
        expect(unit?.body).not.toContain("\u0000")
        expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
          "capabilities^{}report-status",
        )
        expect(chunks.some((chunk) => chunk.text.includes("\u0000"))).toBe(
          false,
        )
        await waitForKnowledgeState(f, {
          lastSha: f.sha,
          runStatus: "completed",
          failedCount: 0,
        })
        expect(await storedDocuments(f)).toMatchObject({
          [servingId]: "active",
        })
      },
    )
  },
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
  "with no worker of the plane, the hydrate still queues the knowledge projection",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      // No worker of this fixture runs the projection: the run waits.
      expect(await runsOf("knowledge-projection", f.workspaceId)).toEqual([
        { sha: null, status: "pending" },
      ])
      // So that no worker of a later test claims it.
      await getSystemDb().execute(
        sql`delete from openworkflow.workflow_runs
          where workflow_name = 'knowledge-projection'
            and input->>'workspaceId' = ${f.workspaceId}`,
      )
    }),
)

it(
  "with model settings that cannot serve the plane (an openai-like URL that is not OpenRouter), the projection writes nothing and the Workspace does not become ready",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        // The fixture puts back its own value at the end.
        process.env.MODEL_PROVIDER = "openai-like"
        await f.publish()
        await vi.waitFor(
          async () => {
            const runs = await runsOf("knowledge-projection", f.workspaceId)
            expect(runs.length).toBeGreaterThan(0)
            expect(runs.every((run) => run.status === "completed")).toBe(true)
          },
          { timeout: 60_000, interval: 500 },
        )
        const key = { orgId: f.org.id, workspaceId: f.workspaceId }
        expect(await getKnowledgeState(key)).toBeNull()
        expect(await readyKnowledgeHeads(f.org.id, [f.workspaceId])).toEqual(
          new Map(),
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
        // The run of the default branch queues its maintenance after it
        // moves the head: count the jobs when that run has ended.
        await vi.waitFor(
          async () =>
            expect(
              (await runsOf("knowledge-projection", f.workspaceId)).every(
                (run) => run.status === "completed",
              ),
            ).toBe(true),
          { timeout: 60_000, interval: 500 },
        )
        const maintenance = (
          await runsOf("knowledge-maintenance", f.workspaceId)
        ).length
        expect(maintenance).toBe(1)
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
        // Until the run of trunk, a read of the default branch shows the tree
        // of main.
        expect((await defaultHead())?.branch).toBe("main")
        const shown = await storedDocuments(f)
        expect(Object.keys(shown).length).toBeGreaterThan(0)
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
        // After it, the tree of trunk, with the same documents.
        expect(await storedDocuments(f)).toEqual(shown)
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
