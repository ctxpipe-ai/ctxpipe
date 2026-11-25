import { sql } from "drizzle-orm"
import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  createKnowledgeStore,
  type PurgeScope,
} from "../../knowledge-store/knowledge-store.js"
import { getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { openWorkflowNamespaceId } from "../namespace.js"

/**
 * Deletes the knowledge plane rows of a deleted org or Workspace from
 * ClickHouse (CTX-1642). The backend reads ClickHouse with a user that has
 * no right to delete (ADR-066 decision 9), so the delete paths queue this
 * workflow, and the worker runs it with the writer user.
 *
 * The delete path removes the Postgres rows first: the Workspace, or the
 * knowledge flag and the heads of the org. A projection run reads the flag
 * and the Workspace at the start of each attempt, before its first write.
 * Thus a run that starts after the delete writes nothing. A run that
 * started before the delete can still write. The purge waits until no
 * projection run of the scope is running, then deletes. The lease of a
 * Workspace cannot give this order for an org: the lease rows go with the
 * org row.
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
    for (let wait = 0; ; wait++) {
      const running = await step.run(
        { name: `find-projection-runs-${wait}` },
        () => runningProjections(input),
      )
      if (running === 0) break
      await step.sleep(`await-projection-runs-${wait}`, "1 minute")
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
          getLogger().set({ knowledgePurge: { skipped: "no_clickhouse" } })
          return null
        }
        const store = createKnowledgeStore(url)
        try {
          const deleted = await store.purge(input)
          // Counts only: the log holds no content.
          getLogger().set({ knowledgePurge: { deleted } })
          return deleted
        } finally {
          await store.close()
        }
      },
    )
  },
)

/**
 * The count of the projection runs of the scope that a worker runs now. A
 * run that waits (pending, or asleep before a retry) reads the flag and the
 * Workspace again when it runs, so it writes nothing for a deleted scope.
 */
async function runningProjections(scope: PurgeScope): Promise<number> {
  const result = await getSystemDb().execute<{ running: string }>(sql`
    select count(*) as running
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = 'knowledge-projection'
      and status = 'running'
      and input->>'orgId' = ${scope.orgId}
      and (${scope.workspaceId ?? null}::text is null
        or input->>'workspaceId' = ${scope.workspaceId ?? null})
  `)
  return Number(result.rows[0]?.running ?? 0)
}
