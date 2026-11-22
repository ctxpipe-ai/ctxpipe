import { sql } from "drizzle-orm"

import { getSystemDb } from "../../db/client.js"
import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
  type WorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { UPGRADE_STATUSES, upgradeJobId } from "./registry.js"
import { isReingestUpgradeKey, REINGEST_WORKFLOW_NAME } from "./reingest.js"
import { cancelRepositoryRuns, cancelRun } from "./stop-orphans.js"

type CancelUpgradeResult =
  | { kind: "canceled"; row: WorkspaceUpgradeRow }
  /** Not a queued, running or canceled re-ingestion: nothing runs to stop. */
  | { kind: "not_running"; row: WorkspaceUpgradeRow }
  | { kind: "missing" }

/**
 * The cancel of an org owner or admin on a queued or running re-ingestion
 * (CTX-1507). The caller checks the role. The row becomes `canceled` first,
 * with no automatic retry, so that a step of the run that is in progress
 * cannot record a result or queue a retry: each write of the run needs the
 * row in `queued` or `running`. Then each run of the row stops: the upgrade
 * runs, their repository runs, and the ingestion runs of those. A canceled
 * run starts no next step, so it makes no new model call and no publish.
 * A second cancel stops the runs again, which changes nothing. A git
 * upgrade has no cancel: its run only opens a pull request. Call it inside
 * the org context.
 */
export async function cancelWorkspaceUpgrade(input: {
  orgId: string
  workspaceId: string
  key: string
}): Promise<CancelUpgradeResult> {
  const canceled = isReingestUpgradeKey(input.key)
    ? await transitionWorkspaceUpgradeRow({
        workspaceId: input.workspaceId,
        key: input.key,
        from: [UPGRADE_STATUSES.queued, UPGRADE_STATUSES.running],
        to: UPGRADE_STATUSES.canceled,
        upgrade: { autoRetry: undefined, waitingForSlot: undefined },
        failureReason: null,
      })
    : null
  const row =
    canceled ?? (await getWorkspaceUpgradeRow(input.workspaceId, input.key))
  if (!row) return { kind: "missing" }
  if (row.status !== UPGRADE_STATUSES.canceled)
    return { kind: "not_running", row }
  await cancelReingestRuns(input)
  return { kind: "canceled", row }
}

/**
 * Cancel each run of the re-ingestion row `key` of the Workspace: the
 * upgrade runs (also a queued run and an automatic retry), their repository
 * runs, and the ingestion runs of those. The upgrade runs go first, so that
 * they start no new repository run.
 */
async function cancelReingestRuns(input: {
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
  for (const run of runs.rows) if (run.active) await cancelRun(run.id)
  for (const run of runs.rows)
    await cancelRepositoryRuns({ ...input, upgradeRunId: run.id })
}
