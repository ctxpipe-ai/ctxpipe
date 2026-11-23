import { and, asc, eq, isNull, sql } from "drizzle-orm"

import { type Db, withOrgDbContext } from "../../db/client.js"
import { sourceSyncEvents } from "../../db/schema/workspace_sources.js"
import { generateObjectId } from "../../lib/id.js"
import type { SourceAdapter } from "./adapter.js"

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
}): Promise<{ id: string; createdAt: Date } | null> {
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
    return oldest ?? null
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
                and run.status in ('pending', 'running', 'sleeping')
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
 */
export async function syncQueuedSourceEvents<T>(input: {
  orgId: string
  connectionId: string
  runId: string
  adapter: SourceAdapter
  sync: (event: unknown) => Promise<T>
}): Promise<{ events: number; result: T | null }> {
  const events = await takeSourceSyncEvents(input)
  if (!events.length) return { events: 0, result: null }
  const result = await input.sync(input.adapter.mergeEvents?.(events))
  await deleteSourceSyncEvents(input)
  return { events: events.length, result }
}
