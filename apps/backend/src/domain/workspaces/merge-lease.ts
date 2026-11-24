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
 *
 * The merges that find the lease busy wait in order, in
 * `workspace_merge_waiters`. Only the first waiter can take a free lease. A
 * release or a take wakes the waiter that is first after it, and only the
 * first waiter checks the lease again on a short timeout. So a holder that
 * fails for good, or a wake that comes before the wait starts, costs one
 * short timeout.
 *
 * Why by hand, and when to delete it: OpenWorkflow 0.10 has no serialization
 * of runs by key, a signal reaches only a wait that started already, and a
 * failed run sends no signal. A runtime that runs the work of one key in
 * series from a durable mailbox (for example an `@effect/cluster` entity for
 * each Workspace, with `DurableDeferred` of `@effect/workflow` for the
 * result) replaces this module: a merge becomes one message to its
 * Workspace. Keep the tests of `merge-lease-native.contract.test.ts` as
 * behavior tests then. See ADR-047.
 */

import { and, asc, eq, sql } from "drizzle-orm"

import { type Db, withOrgDbContext } from "../../db/client.js"
import {
  sandboxLocks,
  workspaceMergeWaiters,
} from "../../db/schema/sandbox-locks.js"
import { OPEN_RUN_STATUSES } from "../workspace-sources/sync-events.js"

/** The key of the lease of a Workspace. */
function leaseKey(workspaceId: string): string {
  return `workspace-semantic-merge:${workspaceId}`
}

/** The signal that wakes one waiting merge run. */
export function workspaceMergeWakeSignal(runId: string): string {
  return `workspace-semantic-merge-wake:${runId}`
}

type LeaseInput = { orgId: string; workspaceId: string; runId: string }

/** True for a run id of a run that can still run its steps. */
function openRun(runId: unknown) {
  return sql<boolean>`exists (
    select 1 from openworkflow.workflow_runs run
    where run.id = ${runId}
      and run.status in (${sql.join(
        OPEN_RUN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})
  )`
}

/** The first open waiter of the Workspace, other than `runId`. */
async function firstWaiter(
  db: Db,
  input: LeaseInput,
): Promise<string | undefined> {
  const [first] = await db
    .select({ runId: workspaceMergeWaiters.runId })
    .from(workspaceMergeWaiters)
    .where(
      and(
        eq(workspaceMergeWaiters.workspaceId, input.workspaceId),
        sql`${workspaceMergeWaiters.runId} <> ${input.runId}`,
        openRun(workspaceMergeWaiters.runId),
      ),
    )
    .orderBy(
      asc(workspaceMergeWaiters.createdAt),
      asc(workspaceMergeWaiters.runId),
    )
    .limit(1)
  return first?.runId
}

/**
 * Take the lease of the Workspace for the run. The lease is taken when the
 * run holds it already (a replay), or when it is free (no holder, or a holder
 * that is not open) and no open waiter is before the run. Then `wake` names
 * the waiter that is first now, so that it waits on the short timeout.
 * Else the run waits in order, and `first` tells if it is the first waiter.
 */
export async function takeWorkspaceMergeLease(
  input: LeaseInput,
): Promise<{ taken: true; wake?: string } | { taken: false; first: boolean }> {
  return withOrgDbContext(input.orgId, async (db) => {
    // One take or release of a Workspace at a time, so that the order of
    // the waiters and the holder agree.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${leaseKey(input.workspaceId)}, 0))`,
    )
    const [holder] = await db
      .select({ owner: sandboxLocks.owner, open: openRun(sandboxLocks.owner) })
      .from(sandboxLocks)
      .where(eq(sandboxLocks.key, leaseKey(input.workspaceId)))
    if (holder?.owner === input.runId) {
      // A replay: wake the next waiter again, in case the first wake failed.
      const wake = await firstWaiter(db, input)
      return wake ? { taken: true, wake } : { taken: true }
    }
    await db
      .delete(workspaceMergeWaiters)
      .where(
        and(
          eq(workspaceMergeWaiters.workspaceId, input.workspaceId),
          sql`not ${openRun(workspaceMergeWaiters.runId)}`,
        ),
      )
    const [own] = await db
      .select({ createdAt: workspaceMergeWaiters.createdAt })
      .from(workspaceMergeWaiters)
      .where(eq(workspaceMergeWaiters.runId, input.runId))
    const [before] = await db
      .select({ runId: workspaceMergeWaiters.runId })
      .from(workspaceMergeWaiters)
      .where(
        and(
          eq(workspaceMergeWaiters.workspaceId, input.workspaceId),
          sql`${workspaceMergeWaiters.runId} <> ${input.runId}`,
          own
            ? sql`(${workspaceMergeWaiters.createdAt}, ${workspaceMergeWaiters.runId}) < (${own.createdAt}, ${input.runId})`
            : sql`true`,
        ),
      )
      .limit(1)
    if (!before && !holder?.open) {
      await db
        .insert(sandboxLocks)
        .values({
          orgId: input.orgId,
          key: leaseKey(input.workspaceId),
          owner: input.runId,
          expiresAt: sql`'infinity'`,
        })
        .onConflictDoUpdate({
          target: [sandboxLocks.orgId, sandboxLocks.key],
          set: { owner: input.runId, expiresAt: sql`'infinity'` },
        })
      await db
        .delete(workspaceMergeWaiters)
        .where(eq(workspaceMergeWaiters.runId, input.runId))
      const wake = await firstWaiter(db, input)
      return wake ? { taken: true, wake } : { taken: true }
    }
    if (!own)
      await db.insert(workspaceMergeWaiters).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        // The time after the lock: a waiter that waited for the lock comes
        // after the waiter before it.
        createdAt: sql`clock_timestamp()`,
      })
    return { taken: false, first: !before }
  })
}

/**
 * Release the lease of the Workspace if the run holds it. Returns the first
 * open waiter, which the caller wakes.
 */
export async function releaseWorkspaceMergeLease(
  input: LeaseInput,
): Promise<string | undefined> {
  return withOrgDbContext(input.orgId, async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${leaseKey(input.workspaceId)}, 0))`,
    )
    await db
      .delete(sandboxLocks)
      .where(
        and(
          eq(sandboxLocks.key, leaseKey(input.workspaceId)),
          eq(sandboxLocks.owner, input.runId),
        ),
      )
    return firstWaiter(db, input)
  })
}
