import { sql } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { ow } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import {
  activeIngestionRunTree,
  REINGEST_REPOSITORY_WORKFLOW_NAME,
  reingestRunKeyPrefix,
} from "./reingest.js"

/** Cancel an ingestion v2 run and its child runs, so that they spend no more. */
export async function cancelIngestionRun(runId: string): Promise<void> {
  for (const id of await activeIngestionRunTree(runId))
    await ow.cancelWorkflowRun(id).catch(() => undefined)
}

/**
 * Cancel each repository run of a re-ingestion whose upgrade run ended
 * without it (failed or canceled), and the ingestion runs of that
 * repository run. A canceled parent run does not cancel its children, and
 * they keep spending. It reads the runs of all orgs, so only two places
 * call it: the upgrade scan (once for each scan, not for each Workspace) and
 * the wait for a slot, because the slot stays taken until these runs end.
 * A read path must not call it.
 */
export async function stopOrphanedReingestRuns(): Promise<void> {
  const namespaceId = openWorkflowNamespaceId()
  const orphans = await getSystemDb().execute<{
    id: string
    input: { orgId?: string; workspaceId?: string; upgradeRunId?: string }
  }>(sql`
    select child.id, child.input
    from openworkflow.workflow_runs child
    join openworkflow.step_attempts parent_step
      on parent_step.namespace_id = child.parent_step_attempt_namespace_id
      and parent_step.id = child.parent_step_attempt_id
    join openworkflow.workflow_runs parent
      on parent.namespace_id = parent_step.namespace_id
      and parent.id = parent_step.workflow_run_id
    where child.namespace_id = ${namespaceId}
      and child.workflow_name = ${REINGEST_REPOSITORY_WORKFLOW_NAME}
      and child.status in ('pending', 'running', 'sleeping')
      and parent.status in ('failed', 'canceled')
  `)
  for (const orphan of orphans.rows) {
    // Cancel the child first, so that it starts no new ingestion run.
    await ow.cancelWorkflowRun(orphan.id).catch(() => undefined)
    const { orgId, workspaceId, upgradeRunId } = orphan.input
    if (!orgId || !workspaceId || !upgradeRunId) continue
    const ingestion = await getSystemDb().execute<{ id: string }>(sql`
      select id from openworkflow.workflow_runs
      where namespace_id = ${namespaceId}
        and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and starts_with(idempotency_key, ${reingestRunKeyPrefix({ orgId, workspaceId, upgradeRunId })})
    `)
    for (const run of ingestion.rows) await cancelIngestionRun(run.id)
  }
}
