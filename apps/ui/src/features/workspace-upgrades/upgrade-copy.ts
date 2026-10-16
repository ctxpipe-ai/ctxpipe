import type { UpgradeStatus, WorkspaceUpgradeItem } from "./queries"

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

export const UPGRADE_BLOCKED_COPY: Record<
  NonNullable<WorkspaceUpgradeItem["blockedReason"]>,
  string
> = {
  write_access:
    "ctx| cannot write to the repository. Give the GitHub App write access, then check the Workspace again.",
}

/** The health line: the format of the repository against the format ctx| reads. */
export function formatHealthLine(
  formatVersion: number | null,
  codeFormat: number,
): string {
  if (formatVersion === null) return "ctx| has not read the repository format."
  if (formatVersion < 0)
    return "The format file in the repository is not valid."
  if (formatVersion >= codeFormat)
    return `The repository uses format ${formatVersion}. It is up to date.`
  return `The repository uses format ${formatVersion}. ctx| reads format ${codeFormat}.`
}

/** The text of the next action for a member. */
export const MEMBER_ASK_ADMIN = "Ask an admin"
