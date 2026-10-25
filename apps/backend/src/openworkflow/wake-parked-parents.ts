import { sql } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { openWorkflowNamespaceId } from "./namespace.js"

/**
 * Make each parked parent run available when the child run it waits for has
 * ended. OpenWorkflow ends the child and wakes the parent in two separate
 * statements. When the worker stops between the two, the parent sleeps for
 * the default wait of one year, and the run never ends. Returns the ids of
 * the parent runs that it woke.
 */
export async function wakeParkedParents(): Promise<string[]> {
  const result = await getSystemDb().execute<{ id: string }>(sql`
    update openworkflow.workflow_runs parent
    set available_at = now(), updated_at = now()
    where parent.namespace_id = ${openWorkflowNamespaceId()}
      and parent.status in ('running', 'sleeping')
      and parent.worker_id is null
      and parent.available_at > now()
      and exists (
        select 1
        from openworkflow.step_attempts wait
        join openworkflow.workflow_runs child
          on child.namespace_id = wait.child_workflow_run_namespace_id
          and child.id = wait.child_workflow_run_id
        where wait.namespace_id = parent.namespace_id
          and wait.workflow_run_id = parent.id
          and wait.kind = 'workflow'
          and wait.status = 'running'
          and child.status in ('completed', 'succeeded', 'failed', 'canceled')
      )
    returning parent.id
  `)
  return result.rows.map((row) => row.id)
}
