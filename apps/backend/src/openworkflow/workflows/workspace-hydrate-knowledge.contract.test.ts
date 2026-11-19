import { writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { sql } from "drizzle-orm"
import { http, passthrough } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { getSystemDb } from "../../db/client.js"
import { servingIdForKnowledgePath } from "../../domain/workspaces/hydrate.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import { getKnowledgeState } from "../../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
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

/** The document keys of the Workspace in ClickHouse, with their status. */
async function storedDocuments(f: NativeHydrationFixture) {
  const store = createKnowledgeStore(writerUrl)
  try {
    return Object.fromEntries(
      (
        await store.listDocumentKeys({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
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
          attemptShas: [],
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
          attemptShas: [tip],
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
          attemptShas: [],
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
