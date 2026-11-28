import { randomUUID } from "node:crypto"

import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { purgeOrgDataBeforeAuthDelete } from "../../domain/repositoryDeletion.js"
import { postgresSandboxLocks } from "../../domain/workspaces/sandbox-lock-store.js"
import {
  createKnowledgeStore,
  type KnowledgeScope,
  NO_KNOWLEDGE_ROWS,
} from "../../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../../knowledge-store/migrate.js"
import {
  getKnowledgeState,
  listBranchHeads,
} from "../../models/knowledge-state.js"
import { workspaceRoutes } from "../../routes/v1/workspaces.js"
import {
  knowledgeRowCounts,
  startClickHouse,
  userUrl,
} from "../../test/clickhouse.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { enqueueWorkflow } from "../client.js"
import { enqueueKnowledgePurge } from "../enqueue-knowledge-purge.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { knowledgeProjection } from "./knowledge-projection.js"
import { IDLE_CHECKS, knowledgePurgeUnversioned } from "./knowledge-purge.js"

/*
 * CTX-1642: the deletion of an org or a Workspace deletes its rows of the
 * knowledge plane, against a real ClickHouse (the writer user of the
 * worker) and a real Postgres. The hydrate of the fixture writes the rows
 * of its Workspace through the real projection.
 */

let clickhouse: Awaited<ReturnType<typeof startClickHouse>> | undefined
let adminUrl: string
let writerUrl: string

beforeAll(async () => {
  // The erase waits until the replaced parts are gone from the disk.
  clickhouse = await startClickHouse({ fastPartCleanup: true })
  adminUrl = await clickhouse.freshDatabase()
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
  { path: "a.md", body: "# Alpha\n\nSee [b](b.md).\n" },
  { path: "b.md", body: "# Beta\n" },
]

/** The count of rows of `scope` in each knowledge table. */
async function rowsOf(scope: KnowledgeScope) {
  if (!clickhouse) throw new Error("No ClickHouse")
  return knowledgeRowCounts(clickhouse.client(adminUrl), scope)
}

/** The rows of `scope` that the parts hold, also the rows that a DELETE hid. */
async function rowsInParts(scope: KnowledgeScope) {
  if (!clickhouse) throw new Error("No ClickHouse")
  return knowledgeRowCounts(clickhouse.client(adminUrl), scope, {
    inParts: true,
  })
}

/** Rows of one file in each knowledge table, for a scope with no hydrate. */
async function seed(scope: KnowledgeScope): Promise<void> {
  const store = createKnowledgeStore(writerUrl)
  const observedAt = new Date("2026-11-25T00:00:00.000Z")
  try {
    await store.writeFileVersions(scope, [
      {
        version: "v1",
        document: {
          docKey: "kept.md",
          kind: "note",
          title: "Kept",
          path: "kept.md",
          sourceType: "other",
          source: "workspace",
          summary: "",
          mime: "",
          createdAt: null,
          updatedAt: null,
          expiresAt: null,
          observedAt,
        },
        chunks: [
          {
            ordinal: 0,
            text: "Kept text",
            startLine: 1,
            endLine: 1,
            embedding: [1, 0, 0],
          },
        ],
        relations: [
          {
            srcChunk: 0,
            predicate: "REFERENCES",
            dstDoc: "ref:key:other",
            confidence: 1,
            validFrom: null,
            validFromIntroduced: false,
            validTo: null,
            source: "link",
            altText: "",
            observedAt,
          },
        ],
        refKeys: ["key:kept"],
      },
    ])
    await store.writeTree(scope, "main", 1, [
      {
        docKey: "kept.md",
        version: "v1",
        path: "kept.md",
        status: "active",
        kind: "note",
        observedAt,
        createdAt: null,
        updatedAt: null,
        expiresAt: null,
        deletedAt: null,
      },
    ])
    await store.writeImageTexts(scope, [
      { blobSha: "sha1", model: "m/a", promptVersion: 1, reading: "text" },
    ])
  } finally {
    await store.close()
  }
}

/** The runs of `workflowName` of the org, with their input and status. */
async function runsOf(workflowName: string, orgId: string) {
  return (
    await getSystemDb().execute(
      sql`select id, input->>'workspaceId' as "workspaceId", status
        from openworkflow.workflow_runs
        where workflow_name = ${workflowName} and input->>'orgId' = ${orgId}
        order by created_at`,
    )
  ).rows as { id: string; workspaceId: string | null; status: string }[]
}

/** Wait until the hydrate wrote the knowledge plane and each run ended. */
async function projected(f: NativeHydrationFixture): Promise<void> {
  await f.publish()
  await vi.waitFor(
    async () => {
      expect(
        await getKnowledgeState({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
        }),
      ).toMatchObject({ lastSha: f.sha, runStatus: "completed" })
      expect(
        (await runsOf("knowledge-projection", f.org.id)).every(
          (run) => run.status === "completed",
        ),
      ).toBe(true)
    },
    { timeout: 60_000, interval: 200 },
  )
}

/**
 * Ends each sleep of the purge runs of the org now, as a clock that runs
 * fast: the sleep step and the parked run.
 */
async function skipPurgeSleeps(orgId: string): Promise<void> {
  const runs = sql`select id from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'knowledge-purge' and input->>'orgId' = ${orgId}`
  await getSystemDb().execute(sql`
    update openworkflow.step_attempts
    set context = jsonb_set(context, '{resumeAt}', '"1970-01-01T00:00:00.000Z"')
    where namespace_id = ${openWorkflowNamespaceId()}
      and kind = 'sleep' and status = 'running' and workflow_run_id in (${runs})
  `)
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs set available_at = now()
    where id in (${runs}) and status = 'running' and worker_id is null
      and available_at > now()
  `)
}

/**
 * Wait until each purge run of the org ended, and return the completed
 * runs. A run that ends with `erased` cancels the next run that it queued.
 */
async function purged(orgId: string) {
  const ended = (run: { status: string }) =>
    run.status === "completed" || run.status === "canceled"
  await vi.waitFor(
    async () => {
      await skipPurgeSleeps(orgId)
      const runs = await runsOf("knowledge-purge", orgId)
      expect(runs.some((run) => run.status === "completed")).toBe(true)
      expect(runs.every(ended)).toBe(true)
    },
    { timeout: 120_000, interval: 200 },
  )
  return (await runsOf("knowledge-purge", orgId)).filter(
    (run) => run.status === "completed",
  )
}

/**
 * The outputs of the completed steps of the purge runs of the org, or of
 * the run `runId`.
 */
async function purgeSteps(orgId: string, runId?: string) {
  return (
    await getSystemDb().execute(sql`
      select s.step_name as name, s.output from openworkflow.step_attempts s
      join openworkflow.workflow_runs r
        on r.namespace_id = s.namespace_id and r.id = s.workflow_run_id
      where r.workflow_name = 'knowledge-purge' and r.input->>'orgId' = ${orgId}
        and (${runId ?? null}::text is null or r.id = ${runId ?? null})
        and s.status = 'completed' and s.kind = 'function'
      order by s.created_at`)
  ).rows as { name: string; output: unknown }[]
}

/** The steps of {@link purgeSteps}, without the queue of the next run. */
async function purgeChecks(orgId: string) {
  return (await purgeSteps(orgId)).filter(
    (step) => step.name !== "queue-next-purge",
  )
}

/** The Workspace delete of the HTTP API. */
async function deleteWorkspace(f: NativeHydrationFixture) {
  const app = workspaceHttpApp(f.org, workspaceRoutes)
  const response = await app.request("/workspaces/knowledge", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmName: f.org.name }),
  })
  return response.status
}

/** A projection run of the Workspace, as one that starts after the purge. */
async function projectAgain(f: NativeHydrationFixture) {
  const handle = await f.runner.runWorkflow(knowledgeProjection.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
  })
  return handle.result({ timeoutMs: 60_000 })
}

it(
  "a Workspace delete queues one purge, which deletes the Workspace rows of each knowledge table and keeps the rows of another Workspace and another org; a later projection run writes nothing",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        const sibling = { orgId: f.org.id, workspaceId: `ws_${randomUUID()}` }
        // The same Workspace id in another org.
        const otherOrg = {
          orgId: `org_${randomUUID()}`,
          workspaceId: f.workspaceId,
        }
        await seed(sibling)
        await seed(otherOrg)
        const projectedRows = await rowsOf(workspace)
        for (const table of [
          "documents",
          "chunks",
          "relations",
          "trees",
        ] as const)
          expect(projectedRows[table], table).toBeGreaterThan(0)
        const kept = await rowsOf(sibling)
        expect(Object.values(kept).every((count) => count > 0)).toBe(true)

        expect(await deleteWorkspace(f)).toBe(204)

        expect(await purged(f.org.id)).toEqual([
          expect.objectContaining({ workspaceId: f.workspaceId }),
        ])
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        // The parts do not hold the deleted rows either (CTX-1672).
        expect(await rowsInParts(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect((await purgeSteps(f.org.id)).at(-1)).toEqual({
          name: "erased",
          output: projectedRows,
        })
        // The run ended with `erased`, so it canceled its next run.
        expect(
          (await runsOf("knowledge-purge", f.org.id)).map((run) => run.status),
        ).toEqual(["completed", "canceled"])
        expect(await rowsOf(sibling)).toEqual(kept)
        expect(await rowsOf(otherOrg)).toEqual(kept)
        // The heads of the Workspace go with its row.
        expect(await getKnowledgeState(workspace)).toBeNull()
        expect(await listBranchHeads(workspace)).toEqual([])

        expect(await projectAgain(f)).toBeNull()
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
      },
    ),
)

it(
  "an org delete queues one purge in its hook, which waits until the org row is gone, then deletes the rows of each Workspace of the org and keeps the rows of another org; a later projection run writes nothing",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        const sibling = { orgId: f.org.id, workspaceId: `ws_${randomUUID()}` }
        const otherOrg = {
          orgId: `org_${randomUUID()}`,
          workspaceId: f.workspaceId,
        }
        await seed(sibling)
        await seed(otherOrg)
        const kept = await rowsOf(otherOrg)
        const before = await rowsOf(workspace)
        expect(before.documents).toBeGreaterThan(0)

        // The `beforeDeleteOrganization` hook commits its Postgres deletes
        // and queues the purge of the org.
        await purgeOrgDataBeforeAuthDelete(f.org.id)
        expect(
          await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ id: repositories.id })
              .from(repositories)
              .where(eq(repositories.orgId, f.org.id)),
          ),
        ).toEqual([])
        expect(await runsOf("knowledge-purge", f.org.id)).toEqual([
          expect.objectContaining({ workspaceId: null }),
        ])
        // While the org row is there, the purge waits and deletes nothing.
        await vi.waitFor(
          async () => {
            await skipPurgeSleeps(f.org.id)
            const outputs = (await purgeChecks(f.org.id)).map(
              (step) => step.output,
            )
            expect(outputs.slice(0, 2)).toEqual(["org", "org"])
          },
          { timeout: 60_000, interval: 200 },
        )
        expect(await rowsOf(workspace)).toEqual(before)

        // Better Auth deletes the org row after the hook.
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, f.org.id))

        expect(await purged(f.org.id)).toEqual([
          expect.objectContaining({ workspaceId: null }),
        ])
        expect((await purgeSteps(f.org.id)).at(-1)?.name).toBe("erased")
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await rowsOf(sibling)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await rowsInParts(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await rowsInParts(sibling)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await rowsOf(otherOrg)).toEqual(kept)
        expect(await getKnowledgeState(workspace)).toBeNull()
        expect(await listBranchHeads(workspace)).toEqual([])

        // The Workspace row of the deleted org stays, but a projection run
        // that starts after the delete of the org row writes nothing.
        expect(await projectAgain(f)).toBeNull()
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await getKnowledgeState(workspace)).toBeNull()
      },
    ),
)

it(
  "the purge of an org whose row stays stops after its idle checks with org_kept, deletes nothing, and keeps the run of the next day",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        const before = await rowsOf(workspace)
        expect(before.documents).toBeGreaterThan(0)
        // As an org delete whose hook queued the purge, and whose delete of
        // the org row then failed.
        await enqueueKnowledgePurge({ orgId: f.org.id, workspaceId: null })
        // The delete can still come: the run of the next day stays.
        await vi.waitFor(
          async () => {
            await skipPurgeSleeps(f.org.id)
            expect(
              (await runsOf("knowledge-purge", f.org.id)).map(
                (run) => run.status,
              ),
            ).toEqual(["completed", "pending"])
          },
          { timeout: 120_000, interval: 200 },
        )
        const outputs = (await purgeChecks(f.org.id)).map((step) => step.output)
        expect(outputs.slice(0, -1)).toEqual(Array(IDLE_CHECKS).fill("org"))
        expect(outputs.at(-1)).toBeNull()
        expect((await purgeSteps(f.org.id)).at(-1)?.name).toBe("org-kept")
        expect(await rowsOf(workspace)).toEqual(before)
        expect(await getKnowledgeState(workspace)).toMatchObject({
          lastSha: f.sha,
        })
      },
    ),
)

it(
  "during a rolling deploy, an org delete through a backend of an earlier version (an org purge with no version) stops each later projection run, also while the org row is there",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        // A run of the applied tip returns `current` while the org is live.
        expect(await projectAgain(f)).toMatchObject({
          summary: { mode: "current" },
        })
        // The old hook queues its purge before Better Auth deletes the org
        // row, and an old worker can run that purge with no wait for the
        // delete.
        await enqueueWorkflow(knowledgePurgeUnversioned.spec, {
          orgId: f.org.id,
          workspaceId: null,
        })
        expect(await projectAgain(f)).toBeNull()
      },
    ),
)

it(
  "a purge waits until the projection run of its Workspace that runs now ends, and then deletes the rows that the run wrote",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        // A projection run that a worker of another process runs now: its
        // lease ends in one hour, so no worker of this test claims it.
        const projectionRun = `run_${randomUUID()}`
        await getSystemDb().execute(sql`
          insert into openworkflow.workflow_runs
            (namespace_id, id, workflow_name, status, config, input, attempts,
             worker_id, available_at, started_at, created_at, updated_at)
          values
            (${openWorkflowNamespaceId()}, ${projectionRun},
             'knowledge-projection', 'running', '{}'::jsonb,
             ${JSON.stringify(workspace)}::jsonb, 1, 'another-worker',
             now() + interval '1 hour', now(), now(), now())
        `)
        expect(await deleteWorkspace(f)).toBe(204)
        // The purge finds the Workspace gone and the projection running.
        await vi.waitFor(
          async () => {
            await skipPurgeSleeps(f.org.id)
            expect(await purgeSteps(f.org.id)).toEqual(
              expect.arrayContaining([
                { name: expect.any(String), output: "projection" },
              ]),
            )
          },
          { timeout: 60_000, interval: 200 },
        )
        // The running projection writes more rows during the purge.
        await seed(workspace)
        const written = await rowsOf(workspace)
        expect(written.image_texts).toBeGreaterThan(0)
        await skipPurgeSleeps(f.org.id)
        expect(await rowsOf(workspace)).toEqual(written)

        // The projection run ends: the next check of the purge deletes.
        await getSystemDb().execute(sql`
          update openworkflow.workflow_runs
          set status = 'completed', worker_id = null, available_at = null,
            finished_at = now()
          where namespace_id = ${openWorkflowNamespaceId()}
            and id = ${projectionRun}
        `)
        await purged(f.org.id)
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
      },
    ),
)

it(
  "the purge of a Workspace whose delete did not happen waits while the sandbox lock of the Workspace is held, then stops after its idle checks and deletes nothing",
  { timeout: 180_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        const before = await rowsOf(workspace)
        expect(before.documents).toBeGreaterThan(0)
        // As a delete that holds the sandbox lock, and then fails.
        await postgresSandboxLocks(f.org.id).withLock(
          `workspace-sandboxes:${f.workspaceId}`,
          async () => {
            await enqueueKnowledgePurge(workspace)
            await vi.waitFor(
              async () => {
                await skipPurgeSleeps(f.org.id)
                const outputs = (await purgeChecks(f.org.id)).map(
                  (step) => step.output,
                )
                expect(outputs.slice(0, 3)).toEqual([
                  "deleting",
                  "deleting",
                  "deleting",
                ])
              },
              { timeout: 60_000, interval: 200 },
            )
          },
        )
        await purged(f.org.id)
        const outputs = (await purgeChecks(f.org.id)).map((step) => step.output)
        const checks = outputs.slice(0, -1)
        expect(checks.filter((output) => output === "workspace")).toHaveLength(
          IDLE_CHECKS,
        )
        expect(
          checks.every(
            (output) => output === "deleting" || output === "workspace",
          ),
        ).toBe(true)
        expect(outputs.at(-1)).toBeNull()
        expect((await purgeSteps(f.org.id)).at(-1)?.name).toBe("workspace-kept")
        // The run ended with no error, so it canceled its next run.
        expect(
          (await runsOf("knowledge-purge", f.org.id)).map((run) => run.status),
        ).toEqual(["completed", "canceled"])
        expect(await rowsOf(workspace)).toEqual(before)
      },
    ),
)

it(
  "a purge run that fails leaves its next run, which purges and erases the rows of the Workspace",
  { timeout: 240_000 },
  async () =>
    withNativeHydrationFixture(
      { files, knowledgePlane: { clickhouseUrl: writerUrl } },
      async (f) => {
        await projected(f)
        const workspace = { orgId: f.org.id, workspaceId: f.workspaceId }
        // ClickHouse is down: the purge step fails and retries.
        vi.stubEnv("CLICKHOUSE_URL", "http://ctxpipe_writer:x@127.0.0.1:1/x")
        expect(await deleteWorkspace(f)).toBe(204)
        await vi.waitFor(
          async () => {
            await skipPurgeSleeps(f.org.id)
            const failed = await getSystemDb().execute(sql`
              select 1 from openworkflow.step_attempts s
              join openworkflow.workflow_runs r on r.id = s.workflow_run_id
              where r.workflow_name = 'knowledge-purge'
                and r.input->>'orgId' = ${f.org.id}
                and s.step_name = 'purge-knowledge-plane'
                and s.status = 'failed'`)
            expect(failed.rows.length).toBeGreaterThan(0)
          },
          { timeout: 60_000, interval: 200 },
        )
        const [first, next] = await runsOf("knowledge-purge", f.org.id)
        expect(next).toMatchObject({ status: "pending" })
        // As after the last retry: the run fails, and its next run stays.
        await getSystemDb().execute(sql`
          update openworkflow.workflow_runs
          set status = 'failed', worker_id = null, available_at = null,
            finished_at = now()
          where namespace_id = ${openWorkflowNamespaceId()}
            and id = ${first?.id}
        `)
        expect(await rowsOf(workspace)).not.toEqual(NO_KNOWLEDGE_ROWS)

        // ClickHouse is back, and the day is over.
        vi.unstubAllEnvs()
        await getSystemDb().execute(sql`
          update openworkflow.workflow_runs set available_at = now()
          where namespace_id = ${openWorkflowNamespaceId()}
            and id = ${next?.id}
        `)
        await vi.waitFor(
          async () => {
            await skipPurgeSleeps(f.org.id)
            expect(
              (await runsOf("knowledge-purge", f.org.id)).map(
                (run) => run.status,
              ),
            ).toEqual(["failed", "completed", "canceled"])
          },
          { timeout: 120_000, interval: 200 },
        )
        expect(await rowsOf(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect(await rowsInParts(workspace)).toEqual(NO_KNOWLEDGE_ROWS)
        expect((await purgeSteps(f.org.id, next?.id)).at(-1)?.name).toBe(
          "erased",
        )
      },
    ),
)
