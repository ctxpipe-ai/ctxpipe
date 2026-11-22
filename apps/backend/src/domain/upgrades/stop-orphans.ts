import { sql } from "drizzle-orm"

import { getSystemDb } from "../../db/client.js"
import { ow } from "../../openworkflow/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { upgradeJobId } from "./registry.js"
import {
  activeIngestionRunTree,
  REINGEST_REPOSITORY_WORKFLOW_NAME,
  REINGEST_WORKFLOW_NAME,
  reingestRunKeyPrefix,
} from "./reingest.js"

/** Cancel an ingestion v2 run and its child runs, so that they spend no more. */
export async function cancelIngestionRun(runId: string): Promise<void> {
  for (const id of await activeIngestionRunTree(runId))
    await ow.cancelWorkflowRun(id).catch(() => undefined)
}

/**
 * Cancel the repository runs of one upgrade run of a re-ingestion, and the
 * ingestion runs that they started. A canceled parent run does not cancel
 * its children, and they keep spending.
 */
async function cancelRepositoryRuns(input: {
  orgId: string
  workspaceId: string
  upgradeRunId: string
}): Promise<void> {
  const namespaceId = openWorkflowNamespaceId()
  const children = await getSystemDb().execute<{ id: string }>(sql`
    select id from openworkflow.workflow_runs
    where namespace_id = ${namespaceId}
      and workflow_name = ${REINGEST_REPOSITORY_WORKFLOW_NAME}
      and status in ('pending', 'running', 'sleeping')
      and input->>'upgradeRunId' = ${input.upgradeRunId}
  `)
  // Cancel the children first, so that they start no new ingestion run.
  for (const child of children.rows)
    await ow.cancelWorkflowRun(child.id).catch(() => undefined)
  const ingestion = await getSystemDb().execute<{ id: string }>(sql`
    select id from openworkflow.workflow_runs
    where namespace_id = ${namespaceId}
      and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
      and starts_with(idempotency_key, ${reingestRunKeyPrefix(input)})
  `)
  for (const run of ingestion.rows) await cancelIngestionRun(run.id)
}

/**
 * Cancel each run of the re-ingestion row `key` of the Workspace: the
 * upgrade runs (also a queued run and an automatic retry), their repository
 * runs, and the ingestion runs of those. The upgrade runs go first, so that
 * they start no new repository run. A second call cancels nothing new.
 */
export async function cancelReingestRuns(input: {
  orgId: string
  workspaceId: string
  key: string
}): Promise<void> {
  // Each upgrade run of the row has the idempotency key `<row id>:<approvedAt>`
  // (see `enqueueWorkspaceUpgradeReingest`). An upgrade run that ended can
  // still have repository runs that spend.
  const runs = await getSystemDb().execute<{ id: string; active: boolean }>(sql`
    select id, status in ('pending', 'running', 'sleeping') as active
    from openworkflow.workflow_runs
    where namespace_id = ${openWorkflowNamespaceId()}
      and workflow_name = ${REINGEST_WORKFLOW_NAME}
      and starts_with(idempotency_key, ${`${upgradeJobId(input.workspaceId, input.key)}:`})
  `)
  for (const run of runs.rows)
    if (run.active) await ow.cancelWorkflowRun(run.id).catch(() => undefined)
  for (const run of runs.rows)
    await cancelRepositoryRuns({ ...input, upgradeRunId: run.id })
}

/**
 * Cancel each repository run of a re-ingestion whose upgrade run ended
 * without it (failed or canceled), and the ingestion runs of that
 * repository run. It reads the runs of all orgs, so only two places
 * call it: the upgrade scan (once for each scan, not for each Workspace) and
 * the wait for a slot, because the slot stays taken until these runs end.
 * A read path must not call it.
 */
export async function stopOrphanedReingestRuns(): Promise<void> {
  const namespaceId = openWorkflowNamespaceId()
  const orphans = await getSystemDb().execute<{
    input: { orgId?: string; workspaceId?: string; upgradeRunId?: string }
  }>(sql`
    select child.input
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
  for (const { input } of orphans.rows) {
    const { orgId, workspaceId, upgradeRunId } = input
    if (orgId && workspaceId && upgradeRunId)
      await cancelRepositoryRuns({ orgId, workspaceId, upgradeRunId })
  }
}
