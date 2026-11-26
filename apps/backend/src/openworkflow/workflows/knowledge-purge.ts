import { sql } from "drizzle-orm"
import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizationExists } from "../../domain/organization-admin.js"
import { withSandboxLockIfFree } from "../../domain/workspaces/sandbox-lock-store.js"
import {
  createKnowledgeStore,
  type KnowledgeStore,
  type PurgeScope,
} from "../../knowledge-store/knowledge-store.js"
import {
  deleteOrgKnowledgeState,
  KNOWLEDGE_PROJECTION_WORKFLOW_NAME,
} from "../../models/knowledge-state.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { cancelRun } from "../run-ended.js"

/**
 * The count of checks that find the Workspace row (or the organization row)
 * there while no delete runs, before the purge stops with no change.
 */
export const IDLE_CHECKS = 10

/**
 * Deletes the knowledge plane rows of a deleted org or Workspace from
 * ClickHouse (CTX-1642). The backend reads ClickHouse with a user that has
 * no right to delete (ADR-066 decision 9), so the delete paths queue this
 * workflow, and the worker runs it with the writer user.
 *
 * The delete removes the Postgres rows that a projection run reads before
 * its first write: the Workspace row, or the organization row. Thus a
 * projection run that starts after the delete writes nothing. A run that
 * started before the delete can still write. The purge waits until the
 * delete committed and no projection run of the scope is running, then
 * deletes. The lease of a Workspace cannot give this order for an org: the
 * lease rows go with the org row.
 *
 * A Workspace delete queues the purge before it starts, so that a failed
 * enqueue deletes nothing and the delete can run again. The delete holds
 * the sandbox lock of the Workspace while it destroys the sandboxes and
 * deletes the row. Thus the purge of a Workspace waits while the row is
 * there. When the row is there and no one holds that lock at
 * {@link IDLE_CHECKS} checks, no delete runs, and the purge stops
 * with no change. An org delete queues the purge in its hook, after the
 * Postgres transaction of the hook and before the delete of the
 * organization row: when the enqueue fails, the organization row stays, and
 * a new delete queues the purge again. The purge of an org waits while the
 * organization row is there. When the row is still there at
 * {@link IDLE_CHECKS} checks, the delete failed, and the purge stops
 * with no change.
 *
 * After the DELETEs, the purge makes ClickHouse remove the deleted rows
 * from the parts, and waits until no part holds a row of the scope and the
 * parts that held them are gone from the disk. A run that fails leaves a
 * purge run for the next day (CTX-1672, ADR-066 decision 9).
 */
const knowledgePurgeWorkflow = (version: string | undefined) =>
  defineWorkflow(
    {
      name: "knowledge-purge",
      version,
      schema: z
        .object({
          orgId: z.string().min(1),
          /** The deleted Workspace; null: the org is deleted. */
          workspaceId: z.string().min(1).nullable(),
        })
        .strict(),
      logFields: (input) => ({
        orgId: input.orgId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      }),
    },
    async ({ input, step, run }) => {
      const url = parseEnv(process.env).CLICKHOUSE_URL
      // A step with this policy retries for about one day before the run
      // fails.
      const retryPolicy = {
        initialInterval: "10s",
        backoffCoefficient: 2,
        maximumInterval: "1h",
        maximumAttempts: 30,
      } as const
      // The first step queues the next purge run of the scope, one day later.
      // A run that ends with no error cancels the queued runs of its scope. A
      // run that fails (a step that still fails after its retries, as while
      // ClickHouse is down) leaves its next run, and the next run queues its
      // own next run first. Thus the purge and the erase start again each day
      // until one run ends, with no operator (ADR-066 decision 9). This step
      // retries each hour until it succeeds, so no run ends before its next
      // run is queued.
      if (url)
        await step.run(
          {
            name: "queue-next-purge",
            retryPolicy: {
              ...retryPolicy,
              maximumAttempts: Number.MAX_SAFE_INTEGER,
            },
          },
          async () => {
            const handle = await enqueueWorkflow(knowledgePurge.spec, input, {
              availableAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              idempotencyKey: `knowledge-purge-next:${run.id}`,
            })
            return handle.workflowRun.id
          },
        )
      let idle = 0
      // A sleeping run holds no worker slot, as in the projection.
      for (let check = 0; ; check++) {
        const wait = await step.run({ name: `check-purge-${check}` }, () =>
          purgeWait(input),
        )
        if (!wait) break
        if ((wait === "workspace" || wait === "org") && ++idle >= IDLE_CHECKS)
          return step.run({ name: `${wait}-kept` }, async () => {
            // A kept Workspace row means no delete. A kept organization row
            // can be a slow delete (the hook purges codesearch and FalkorDB
            // before Better Auth deletes the row), so the run of the next day
            // stays: it purges after the delete, and it never deletes while
            // the row is there.
            if (wait === "workspace") await cancelQueuedPurges(input)
            getLogger().set({
              step: "knowledge-purge",
              knowledgePurge: { outcome: `${wait}_kept` },
            })
            return null
          })
        await step.sleep(`await-purge-${check}`, "1 minute")
      }
      const deleted = await step.run(
        { name: "purge-knowledge-plane", retryPolicy },
        async () => {
          // The Workspace rows of a deleted org stay, so a projection run
          // that ran before the delete can have written the state again. The
          // state of a deleted Workspace went with its row.
          if (input.workspaceId === null)
            await deleteOrgKnowledgeState(input.orgId)
          // A worker with no ClickHouse wrote no knowledge plane rows.
          if (!url) {
            getLogger().set({
              step: "knowledge-purge",
              knowledgePurge: { outcome: "no_clickhouse" },
            })
            return null
          }
          return withStore(url, async (store) => {
            const deleted = await store.purge(input)
            // Counts only: the log holds no content.
            getLogger().set({
              step: "knowledge-purge",
              knowledgePurge: { outcome: "purged", deleted },
            })
            return deleted
          })
        },
      )
      if (deleted === null) return null
      // The DELETEs only hid the rows. The erase removes their bytes from the
      // parts (CTX-1672), also when these DELETEs found no row: an earlier
      // attempt of the purge step, or an earlier run, can have hidden them.
      // The parts to wait for, in a step of their own: a retry of the erase
      // finds no hidden row in a part that a mutation already rewrote.
      const parts = await step.run(
        { name: "find-purged-parts", retryPolicy },
        () => withStore(url, (store) => store.findPurgedParts(input)),
      )
      await step.run({ name: "erase-purged-rows", retryPolicy }, () =>
        withStore(url, (store) => store.erasePurged(input)),
      )
      // Done when the active parts hold no row of the scope, and the parts
      // that held them are gone from the disk. A part that a merge made
      // after the erase holds no hidden row: a merge drops them.
      for (let check = 1; ; check++) {
        const left = await step.run(
          { name: `check-erase-${check}`, retryPolicy },
          () =>
            withStore(url, async (store) => {
              const rows = await store.purgedRowsInParts(input)
              // Each hour: the erase again, in case an operator killed a
              // mutation.
              if (rows > 0 && check % 6 === 0) await store.erasePurged(input)
              return { rows, parts: await store.partsLeft(parts) }
            }),
        )
        if (left.rows === 0 && left.parts === 0) break
        // ClickHouse stores a mutation on disk and retries it until it is
        // done. 144 checks, 10 minutes apart, are one day after the erase.
        // The run then fails, and the next run starts the erase again.
        if (check >= 144)
          throw new Error(
            `One day after the erase, ${left.rows} purged rows and ${left.parts} parts are left`,
          )
        await step.sleep(`await-erase-${check}`, "10 minutes")
      }
      return step.run({ name: "erased" }, async () => {
        await cancelQueuedPurges(input)
        getLogger().set({
          step: "knowledge-purge",
          knowledgePurge: { outcome: "erased" },
        })
        return deleted
      })
    },
  )

/**
 * The version of the plane with no flag (CTX-1712). An org purge waits for
 * the delete of the organization row. A worker of an earlier version does
 * not wait, so it must not run these runs: it has only the run with no
 * version, and OpenWorkflow gives the run back to the queue until a worker
 * of this version takes it.
 */
export const knowledgePurge = knowledgePurgeWorkflow("2")

/**
 * The runs that a backend of an earlier version queued, with no version. A
 * worker of this version runs them with the same body.
 */
export const knowledgePurgeUnversioned = knowledgePurgeWorkflow(undefined)

/**
 * Cancels the purge runs of `scope` that wait for their start time: the
 * next runs that this run, and a run before it, queued.
 */
async function cancelQueuedPurges(scope: PurgeScope): Promise<void> {
  const queued = await getSystemDb().execute<{ id: string }>(sql`
    select id from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'knowledge-purge'
      and status = 'pending' and available_at > now()
      and input->>'orgId' = ${scope.orgId}
      and input->'workspaceId' = ${JSON.stringify(scope.workspaceId)}::jsonb
  `)
  for (const { id } of queued.rows) await cancelRun(id)
}

/** Runs `use` with a store of the writer at `url`, and closes the store. */
async function withStore<T>(
  url: string | undefined,
  use: (store: KnowledgeStore) => Promise<T>,
): Promise<T> {
  const store = createKnowledgeStore(url)
  try {
    return await use(store)
  } finally {
    await store.close()
  }
}

/**
 * Why the purge must wait now, or null when it can delete:
 * - `deleting`: the Workspace row is there, and its delete (or another
 *   holder of its sandbox lock) runs now;
 * - `workspace`: the Workspace row is there, and no one holds that lock;
 * - `org`: the purge is of an org, and the organization row is
 *   there (its delete did not commit yet, or it failed);
 * - `projection`: a projection run of the scope is `running`. A run asleep
 *   in a step (as one that waits for the projection lease) also counts.
 *   A `pending` run (new, or before a retry) does not: it reads the
 *   organization and the Workspace again when it runs, so it writes nothing
 *   for a deleted scope.
 */
async function purgeWait(
  scope: PurgeScope,
): Promise<"deleting" | "workspace" | "org" | "projection" | null> {
  const { orgId, workspaceId } = scope
  if (workspaceId === null && (await organizationExists(orgId))) return "org"
  if (
    workspaceId !== null &&
    (await withOrgDbContext(orgId, () => getWorkspaceById(workspaceId, orgId)))
  ) {
    // The key of `withDestroyedWorkspaceSandboxes`, which the delete holds.
    const lock = await withSandboxLockIfFree(
      orgId,
      `workspace-sandboxes:${workspaceId}`,
      async () => undefined,
    )
    return lock.busy ? "deleting" : "workspace"
  }
  const result = await getSystemDb().execute<{ running: string }>(sql`
    select count(*) as running
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = ${KNOWLEDGE_PROJECTION_WORKFLOW_NAME}
      and status = 'running'
      and input->>'orgId' = ${orgId}
      and (${workspaceId}::text is null
        or input->>'workspaceId' = ${workspaceId})
  `)
  return Number(result.rows[0]?.running ?? 0) > 0 ? "projection" : null
}
