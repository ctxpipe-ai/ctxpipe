import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
  type WorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { UPGRADE_STATUSES } from "./registry.js"
import { isReingestUpgradeKey } from "./reingest.js"
import { cancelReingestRuns } from "./stop-orphans.js"

type CancelUpgradeResult =
  | { kind: "canceled"; row: WorkspaceUpgradeRow }
  /** The row is not queued, running or canceled: nothing runs to stop. */
  | { kind: "not_running"; row: WorkspaceUpgradeRow }
  /** A git upgrade: its run only opens a pull request, and it has no cancel. */
  | { kind: "format"; row: WorkspaceUpgradeRow }
  | { kind: "missing" }

/**
 * The cancel of an org owner or admin on a queued or running re-ingestion
 * (CTX-1507). The caller checks the role. The row becomes `canceled` first,
 * with no automatic retry, so that a step of the run that is in progress
 * cannot record a result or queue a retry: each write of the run needs the
 * row in `queued` or `running`. Then each run of the row stops: the upgrade
 * runs, their repository runs, and the ingestion runs of those. A canceled
 * run starts no next step, so it makes no new model call and no publish.
 * A second cancel stops the runs again, which changes nothing. Call it
 * inside the org context.
 */
export async function cancelWorkspaceUpgrade(input: {
  orgId: string
  workspaceId: string
  key: string
}): Promise<CancelUpgradeResult> {
  if (!isReingestUpgradeKey(input.key)) {
    const row = await getWorkspaceUpgradeRow(input.workspaceId, input.key)
    return row ? { kind: "format", row } : { kind: "missing" }
  }
  const canceled = await transitionWorkspaceUpgradeRow({
    workspaceId: input.workspaceId,
    key: input.key,
    from: [UPGRADE_STATUSES.queued, UPGRADE_STATUSES.running],
    to: UPGRADE_STATUSES.canceled,
    upgrade: { autoRetry: undefined, waitingForSlot: undefined },
    failureReason: null,
  })
  const row =
    canceled ?? (await getWorkspaceUpgradeRow(input.workspaceId, input.key))
  if (!row) return { kind: "missing" }
  if (row.status !== UPGRADE_STATUSES.canceled)
    return { kind: "not_running", row }
  await cancelReingestRuns(input)
  return { kind: "canceled", row }
}
