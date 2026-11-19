import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { getSystemDb } from "../../db/client.js"
import { servingIdForKnowledgePath } from "../../domain/workspaces/hydrate.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import { getKnowledgeState } from "../../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../../test/clickhouse.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

/*
 * The hydrate workflow runs the projection writer of the knowledge plane
 * after the old projections, only for an org whose flag is not `off`
 * (ADR-069 decision 9).
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

/** The maintenance runs that the writer queued for the Workspace. */
async function maintenanceRuns(workspaceId: string) {
  return (
    await getSystemDb().execute(
      sql`select input->>'sha' as sha from openworkflow.workflow_runs
        where workflow_name = 'knowledge-maintenance'
          and input->>'workspaceId' = ${workspaceId}`,
    )
  ).rows
}

it(
  "with the flag `shadow`, the hydrate also writes the knowledge plane and queues the maintenance job",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await f.publish()
        const scope = { orgId: f.org.id, workspaceId: f.workspaceId }
        expect(await getKnowledgeState(scope)).toMatchObject({
          lastSha: f.sha,
          attemptShas: [],
          runStatus: "completed",
          failedCount: 0,
        })
        const store = createKnowledgeStore(writerUrl)
        try {
          const keyOf = (path: string) =>
            servingIdForKnowledgePath(f.workspaceId, path)
          expect(
            Object.fromEntries(
              (await store.listDocumentKeys(scope)).map((row) => [
                row.docKey,
                row.status,
              ]),
            ),
          ).toEqual({
            [keyOf("a.md")]: "active",
            [keyOf("b.md")]: "active",
            [keyOf("c.md")]: "missing",
          })
        } finally {
          await store.close()
        }
        expect(await maintenanceRuns(f.workspaceId)).toEqual([{ sha: f.sha }])
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
      expect(await maintenanceRuns(f.workspaceId)).toEqual([])
    }),
)
