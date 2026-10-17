import type {
  UpgradeEstimate,
  UpgradeStatus,
  WorkspaceUpgradeItem,
} from "./queries"

/** An item that still needs work. Only `completed` is done. */
export function upgradeIsPending(item: WorkspaceUpgradeItem): boolean {
  return item.status !== "completed"
}

/** The owner or admin can press Start on these. */
export function upgradeCanStart(item: WorkspaceUpgradeItem): boolean {
  return item.status === "awaiting_operator" || item.status === "failed"
}

export const UPGRADE_STATUS_TAG: Record<
  UpgradeStatus,
  { label: string; className: string; pulse?: boolean }
> = {
  awaiting_operator: {
    label: "Ready to start",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  },
  queued: {
    label: "Queued",
    className: "border-border bg-zinc-800 text-muted-foreground",
    pulse: true,
  },
  running: {
    label: "Preparing the pull request",
    className: "border-border bg-zinc-800 text-muted-foreground",
    pulse: true,
  },
  pr_open: {
    label: "Waiting for merge",
    className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  },
  completed: {
    label: "Applied",
    className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  },
  failed: {
    label: "Failed",
    className: "border-red-400/30 bg-red-400/10 text-red-200",
  },
  blocked: {
    label: "Blocked",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  },
}

export const UPGRADE_BLOCKED_COPY: Record<string, string> = {
  write_access:
    "ctx| needs write access through the GitHub App to open the upgrade pull request. Connect the Workspace repository with the GitHub App, then check the Workspace again.",
}

/** The toast after the start of an item. A re-ingestion opens no pull request on start. */
export function upgradeStartedMessage(item: { kind: string }): string {
  return item.kind === "reingest"
    ? "The re-ingestion is queued. ctx| reads each source repository again."
    : "The upgrade is queued. ctx| prepares a pull request."
}

/** The estimate of a re-ingestion, from the p50 to the p90 value. */
export function formatUpgradeEstimate(estimate: UpgradeEstimate): string {
  const usd = (value: number) => `$${value.toFixed(2)}`
  const repositories =
    estimate.repositories === 1
      ? "1 repository"
      : `${estimate.repositories} repositories`
  return `Estimated cost: ${usd(estimate.costUsd.low)} to ${usd(estimate.costUsd.high)} for ${repositories}, about ${estimate.minutes.low} to ${estimate.minutes.high} minutes.`
}

/** The health line: the format of the repository against the format ctx| reads. */
export function formatHealthLine(
  formatVersion: number | null,
  codeFormat: number,
): string {
  if (formatVersion === null) return "ctx| has not read the repository format."
  if (formatVersion < 0)
    return "The format file in the repository is not valid."
  if (formatVersion > codeFormat)
    return `The repository uses format ${formatVersion}. ctx| reads format ${codeFormat}. This Workspace needs a newer ctx| version.`
  if (formatVersion === codeFormat)
    return `The repository uses format ${formatVersion}. It is up to date.`
  return `The repository uses format ${formatVersion}. ctx| reads format ${codeFormat}.`
}

/** The reason a blocked item gives. */
export function upgradeBlockedText(item: WorkspaceUpgradeItem): string {
  return (
    (item.blockedReason ? UPGRADE_BLOCKED_COPY[item.blockedReason] : null) ??
    item.note ??
    "ctx| cannot start this upgrade now."
  )
}

/**
 * The lines of the home alert. Each line comes from a status that is present
 * in the pending items. `isAdmin` is `null` while the role loads.
 */
export function upgradeAlertLines(
  pending: WorkspaceUpgradeItem[],
  isAdmin: boolean | null,
): string[] {
  const has = (...statuses: UpgradeStatus[]) =>
    pending.some((item) => statuses.includes(item.status))
  const lines: string[] = []
  if (has("awaiting_operator", "failed"))
    lines.push(
      isAdmin === false
        ? "Ask an admin to start it."
        : "An owner or admin must start it.",
    )
  if (has("queued", "running")) lines.push("An upgrade is running.")
  if (has("pr_open")) lines.push("Review and merge the upgrade pull request.")
  for (const item of pending)
    if (item.status === "blocked") lines.push(upgradeBlockedText(item))
  return lines
}

/** The text of the next action for a member. */
export const MEMBER_ASK_ADMIN = "Ask an admin"
