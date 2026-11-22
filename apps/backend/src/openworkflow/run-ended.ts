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
