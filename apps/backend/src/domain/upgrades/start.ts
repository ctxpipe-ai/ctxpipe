import {
  failStoppedUpgradeRun,
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
  type WorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { enqueueWorkspaceUpgrade } from "../../openworkflow/workflows/workspace-upgrade.js"
import { enqueueWorkspaceUpgradeReingest } from "../../openworkflow/workflows/workspace-upgrade-reingest.js"
import { UPGRADE_STATUSES } from "./registry.js"
import { isReingestUpgradeKey } from "./reingest.js"

export type StartUpgradeResult =
  | { kind: "queued"; row: WorkspaceUpgradeRow }
  /** Started before: a run or an open pull request exists. Nothing new starts. */
  | { kind: "existing"; row: WorkspaceUpgradeRow }
  | { kind: "blocked"; row: WorkspaceUpgradeRow }
  | { kind: "completed"; row: WorkspaceUpgradeRow }
  | { kind: "missing" }

/**
 * The click of an org owner or admin on one upgrade (ADR-053 section 7). The
 * caller checks the role. Only a row that waits for the operator, or that
 * failed, starts; of two clicks, only one queues a run. A started upgrade
 * returns its row again, so a second click opens no second pull request.
 * A re-ingestion starts its own workflow; the estimate stays on the row,
 * so the run log keeps what the operator saw. Call it inside the org
 * context.
 */
export async function startWorkspaceUpgrade(input: {
  orgId: string
  workspaceId: string
  key: string
  userId: string
}): Promise<StartUpgradeResult> {
  // A run that stopped without its result must not keep the row: then this
  // click starts a new run.
  await failStoppedUpgradeRun(input.workspaceId, input.key)
  const row = await getWorkspaceUpgradeRow(input.workspaceId, input.key)
  if (!row) return { kind: "missing" }
  if (row.status === UPGRADE_STATUSES.blocked) return { kind: "blocked", row }
  if (row.status === UPGRADE_STATUSES.completed)
    return { kind: "completed", row }
  const approvedAt = new Date().toISOString()
  const started = await transitionWorkspaceUpgradeRow({
    workspaceId: input.workspaceId,
    key: input.key,
    from: [UPGRADE_STATUSES.awaiting_operator, UPGRADE_STATUSES.failed],
    to: UPGRADE_STATUSES.queued,
    upgrade: { approvedBy: input.userId, approvedAt, note: undefined },
    workflowRunId: null,
    failureReason: null,
  })
  if (!started) {
    const current = await getWorkspaceUpgradeRow(input.workspaceId, input.key)
    return current ? { kind: "existing", row: current } : { kind: "missing" }
  }
  try {
    const enqueue = isReingestUpgradeKey(input.key)
      ? enqueueWorkspaceUpgradeReingest
      : enqueueWorkspaceUpgrade
    await enqueue({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      key: input.key,
      approvedAt,
    })
  } catch (error) {
    await transitionWorkspaceUpgradeRow({
      workspaceId: input.workspaceId,
      key: input.key,
      from: [UPGRADE_STATUSES.queued],
      to: UPGRADE_STATUSES.failed,
      failureReason: "ctx| could not queue the upgrade. Start it again.",
    })
    throw error
  }
  return { kind: "queued", row: started }
}
