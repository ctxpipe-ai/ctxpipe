import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * Whether the workflow run has not ended: it is pending, running or
 * sleeping. A cancel ends a run, but a step of it that is in progress
 * continues. Such a step reads this before an effect that must not happen
 * after a cancel, for example a push. A run that does not exist has ended.
 */
export async function workflowRunActive(runId: string): Promise<boolean> {
  const result = await getSystemDb().execute<{ active: boolean }>(sql`
    select status in ('pending', 'running', 'sleeping') as active
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()} and id = ${runId}
  `)
  return result.rows[0]?.active === true
}
