import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * Whether the workflow run ended: it is completed, failed or canceled. A
 * cancel ends a run, but a step of it that is in progress continues. Such a
 * step reads this before an effect that must not happen after a cancel, for
 * example a push. A run id with no run is not an ended run.
 */
export async function workflowRunEnded(runId: string): Promise<boolean> {
  const result = await getSystemDb().execute<{ ended: boolean }>(sql`
    select status in ('completed', 'failed', 'canceled') as ended
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
  `)
  return result.rows[0]?.ended === true
}

/**
 * Run `effect` only while the workflow run has not ended, and hold a cancel
 * of the run until `effect` ends. A share lock on the row of the run keeps
 * a cancel (an update of the row) waiting, so a cancel comes either before
 * the read, and `effect` does not run, or after `effect`. Use it for one
 * short effect that must not happen after a cancel, for example a push.
 */
export async function whileWorkflowRunActive<T>(
  runId: string,
  effect: () => Promise<T>,
): Promise<T> {
  return getSystemDb().transaction(async (tx) => {
    const result = await tx.execute<{ active: boolean }>(sql`
      select status in ('pending', 'running', 'sleeping') as active
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
      for share
    `)
    if (result.rows[0]?.active !== true)
      throw new Error(`The workflow run ${runId} ended before the effect`)
    // The transaction waits for the effect: no server limit may end it.
    await tx.execute(
      sql`select set_config('idle_in_transaction_session_timeout', '0', true)`,
    )
    return effect()
  })
}
