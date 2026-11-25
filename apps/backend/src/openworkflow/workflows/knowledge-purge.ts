import { sql } from "drizzle-orm"
import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  createKnowledgeStore,
  type PurgeScope,
} from "../../knowledge-store/knowledge-store.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { openWorkflowNamespaceId } from "../namespace.js"

/**
 * Deletes the knowledge plane rows of a deleted org or Workspace from
 * ClickHouse (CTX-1642). The backend reads ClickHouse with a user that has
 * no right to delete (ADR-066 decision 9), so the delete paths queue this
 * workflow, and the worker runs it with the writer user.
 *
 * The delete removes the Postgres rows that a projection run reads before
 * its first write: the Workspace row, or the knowledge flag of the org.
 * Thus a projection run that starts after the delete writes nothing. A run
 * that started before the delete can still write. The purge waits until
 * the delete committed and no projection run of the scope is running, then
 * deletes. The lease of a Workspace cannot give this order for an org: the
 * lease rows go with the org row.
 *
 * A Workspace delete queues the purge before its transaction, so that a
 * failed enqueue deletes nothing and the delete can run again. Thus the
 * purge of a Workspace also waits until the Workspace row is gone. When the
 * row is still there after 10 checks (10 minutes), the delete did not
 * happen, and the purge stops with no change. An org delete queues the
 * purge after its Postgres transaction: when the enqueue fails, the
 * organization row stays, and a new delete queues the purge again.
 */
export const knowledgePurge = defineWorkflow(
  {
    name: "knowledge-purge",
    schema: z
      .object({
        orgId: z.string().min(1),
        /** The deleted Workspace; absent: the org is deleted. */
        workspaceId: z.string().min(1).optional(),
      })
      .strict(),
    logFields: (input) => ({
      orgId: input.orgId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }),
  },
  async ({ input, step }) => {
    // A sleeping run holds no worker slot, as in the projection.
    for (let check = 0; ; check++) {
      const wait = await step.run({ name: `check-purge-${check}` }, () =>
        purgeWait(input),
      )
      if (!wait) break
      if (wait === "workspace" && check + 1 >= 10)
        return step.run({ name: "workspace-kept" }, async () => {
          getLogger().set({
            step: "knowledge-purge",
            knowledgePurge: { outcome: "workspace_kept" },
          })
          return null
        })
      await step.sleep(`await-purge-${check}`, "1 minute")
    }
    return step.run(
      {
        name: "purge-knowledge-plane",
        // A purge that fails is not queued again, so it retries for about
        // one day before the run fails.
        retryPolicy: {
          initialInterval: "10s",
          backoffCoefficient: 2,
          maximumInterval: "1h",
          maximumAttempts: 30,
        },
      },
      async () => {
        const url = parseEnv(process.env).CLICKHOUSE_URL
        // A worker with no ClickHouse wrote no knowledge plane rows.
        if (!url) {
          getLogger().set({
            step: "knowledge-purge",
            knowledgePurge: { outcome: "no_clickhouse" },
          })
          return null
        }
        const store = createKnowledgeStore(url)
        try {
          const deleted = await store.purge(input)
          // Counts only: the log holds no content.
          getLogger().set({
            step: "knowledge-purge",
            knowledgePurge: { outcome: "purged", deleted },
          })
          return deleted
        } finally {
          await store.close()
        }
      },
    )
  },
)

/**
 * Why the purge must wait now: the Workspace row is still there, or a
 * projection run of the scope runs now. Null: the purge can delete. A
 * projection run that waits (pending, or asleep before a retry) reads the
 * flag and the Workspace again when it runs, so it writes nothing for a
 * deleted scope.
 */
async function purgeWait(
  scope: PurgeScope,
): Promise<"workspace" | "projection" | null> {
  const { orgId, workspaceId } = scope
  if (
    workspaceId &&
    (await withOrgDbContext(orgId, () => getWorkspaceById(workspaceId, orgId)))
  )
    return "workspace"
  const result = await getSystemDb().execute<{ running: string }>(sql`
    select count(*) as running
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'knowledge-projection'
      and status = 'running'
      and input->>'orgId' = ${orgId}
      and (${workspaceId ?? null}::text is null
        or input->>'workspaceId' = ${workspaceId ?? null})
  `)
  return Number(result.rows[0]?.running ?? 0) > 0 ? "projection" : null
}
