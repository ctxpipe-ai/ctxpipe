import { and, asc, eq, isNull, sql } from "drizzle-orm"

import { type Db, withOrgDbContext } from "../../db/client.js"
import { sourceSyncEvents } from "../../db/schema/workspace_sources.js"
import { generateObjectId } from "../../lib/id.js"
import { withSandboxLockIfFree } from "../workspaces/sandbox-lock-store.js"
import type { SourceAdapter } from "./adapter.js"

/**
 * The window of a webhook sync of a connection. The webhooks of one
 * connection in this window give one sources sync, and so one connector
 * mirror write and one merge for each Workspace. Each provider that
 * coalesces its webhooks uses this window.
 */
export const SOURCE_SYNC_WINDOW_MS = 10 * 60 * 1000

/** The OpenWorkflow statuses of a run that can still run its steps. */
export const OPEN_RUN_STATUSES = ["pending", "running", "sleeping"] as const

/**
 * The webhook events of one connection wait in `source_sync_events` for one
 * coalesced sources sync (CTX-1595). These functions are the only access to
 * the table. The add and the take lock the connection, so that an added event
 * is either in the take of a run, or names the next run.
 */

function lockConnection(db: Db, connectionId: string) {
  return db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`source_sync_events:${connectionId}`}, 0))`,
  )
}

/**
 * Add one event. Returns the oldest event that waits and no run took. The
 * run of that event takes this event too, so each webhook that gets the same
 * oldest event joins the same run.
 */
export async function addSourceSyncEvent(input: {
  orgId: string
  connectionId: string
  event: unknown
}): Promise<{ id: string; createdAt: Date }> {
  return withOrgDbContext(input.orgId, async (db) => {
    await lockConnection(db, input.connectionId)
    await db.insert(sourceSyncEvents).values({
      id: generateObjectId("sevt"),
      orgId: input.orgId,
      connectionId: input.connectionId,
      event: input.event,
      // The time after the lock, not the start of the transaction: an event
      // that waited for the lock is younger than the event before it.
      createdAt: sql`clock_timestamp()`,
    })
    const [oldest] = await db
      .select({
        id: sourceSyncEvents.id,
        createdAt: sourceSyncEvents.createdAt,
      })
      .from(sourceSyncEvents)
      .where(
        and(
          eq(sourceSyncEvents.connectionId, input.connectionId),
          isNull(sourceSyncEvents.runId),
        ),
      )
      .orderBy(asc(sourceSyncEvents.createdAt), asc(sourceSyncEvents.id))
      .limit(1)
    // The lock holds, so the new event waits at least.
    if (!oldest) throw new Error("The new source sync event is missing")
    return oldest
  })
}

/**
 * Take the events of the connection for one run, oldest first: the events
 * that wait, the events that this run took before (a retry), and the events
 * of a run that ended without their delete.
 */
async function takeSourceSyncEvents(input: {
  orgId: string
  connectionId: string
  runId: string
}): Promise<unknown[]> {
  const rows = await withOrgDbContext(input.orgId, async (db) => {
    await lockConnection(db, input.connectionId)
    return db
      .update(sourceSyncEvents)
      .set({ runId: input.runId })
      .where(
        and(
          eq(sourceSyncEvents.connectionId, input.connectionId),
          sql`(${sourceSyncEvents.runId} is null
            or ${sourceSyncEvents.runId} = ${input.runId}
            or not exists (
              select 1 from openworkflow.workflow_runs run
              where run.id = ${sourceSyncEvents.runId}
                and run.status in (${sql.join(
                  OPEN_RUN_STATUSES.map((status) => sql`${status}`),
                  sql`, `,
                )})
            ))`,
        ),
      )
      .returning({
        id: sourceSyncEvents.id,
        createdAt: sourceSyncEvents.createdAt,
        event: sourceSyncEvents.event,
      })
  })
  return rows
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((row) => row.event)
}

/** Delete the events that one run synced. */
async function deleteSourceSyncEvents(input: {
  orgId: string
  runId: string
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db.delete(sourceSyncEvents).where(eq(sourceSyncEvents.runId, input.runId)),
  )
}

/**
 * The body of a coalesced sync: take the events of the connection, join them
 * with the adapter, sync one time, and then delete the events. A retry after
 * a failure takes the same events again, and the events that came since.
 *
 * One sync of a connection runs at a time: a lease for the connection holds
 * from the take to the delete. While another sync holds it, this gives
 * `busy` and takes nothing, so the events that come wait for this run.
 */
export async function syncQueuedSourceEvents<T>(input: {
  orgId: string
  connectionId: string
  runId: string
  adapter: SourceAdapter
  sync: (event: unknown) => Promise<T>
}): Promise<
  { busy: true } | { busy: false; events: number; result: T | null }
> {
  const locked = await withSandboxLockIfFree(
    input.orgId,
    `workspace-sources-sync:${input.connectionId}`,
    async () => {
      const events = await takeSourceSyncEvents(input)
      if (!events.length) return { events: 0, result: null }
      const result = await input.sync(input.adapter.mergeEvents?.(events))
      await deleteSourceSyncEvents(input)
      return { events: events.length, result }
    },
  )
  return locked.busy ? locked : { busy: false, ...locked.value }
}
