/**
 * One semantic merge of a Workspace runs at a time (CTX-1598). Before, the
 * merges of one Workspace raced on its default branch: each push made the
 * other merges discard their merge commits and merge again.
 *
 * The merge run holds a lease on its Workspace from its first acquire to its
 * push. The lease is a `sandbox_locks` row that names the run, with no time
 * limit. It is free when its run releases it, or when its run is not open
 * any more (completed, failed, or canceled). Thus a crashed worker cannot
 * keep the lease, and a run that sleeps keeps it.
 */

import { and, eq, sql } from "drizzle-orm"

import { withOrgDbContext } from "../../db/client.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { OPEN_RUN_STATUSES } from "../workspace-sources/sync-events.js"

/**
 * The key of the lease of a Workspace. It is also the name of the signal
 * that a release sends to the merges that wait.
 */
export function workspaceMergeLeaseKey(workspaceId: string): string {
  return `workspace-semantic-merge:${workspaceId}`
}

/**
 * Take the lease of the Workspace for the run. True when the run holds the
 * lease now: the lease was free, the run held it already (a replay), or its
 * holder is not open any more.
 */
export async function takeWorkspaceMergeLease(input: {
  orgId: string
  workspaceId: string
  runId: string
}): Promise<boolean> {
  const taken = await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(sandboxLocks)
      .values({
        orgId: input.orgId,
        key: workspaceMergeLeaseKey(input.workspaceId),
        owner: input.runId,
        expiresAt: sql`'infinity'`,
      })
      .onConflictDoUpdate({
        target: [sandboxLocks.orgId, sandboxLocks.key],
        set: { owner: input.runId, expiresAt: sql`'infinity'` },
        setWhere: sql`${sandboxLocks.owner} = ${input.runId}
          or not exists (
            select 1 from openworkflow.workflow_runs run
            where run.id = ${sandboxLocks.owner}
              and run.status in (${sql.join(
                OPEN_RUN_STATUSES.map((status) => sql`${status}`),
                sql`, `,
              )})
          )`,
      })
      .returning({ owner: sandboxLocks.owner }),
  )
  return taken.length > 0
}

/** Release the lease of the Workspace if the run holds it. */
export async function releaseWorkspaceMergeLease(input: {
  orgId: string
  workspaceId: string
  runId: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .delete(sandboxLocks)
      .where(
        and(
          eq(sandboxLocks.key, workspaceMergeLeaseKey(input.workspaceId)),
          eq(sandboxLocks.owner, input.runId),
        ),
      ),
  )
}
