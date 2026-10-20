import type { UpgradeStatus, WorkspaceUpgradeItem } from "./queries"

/** An item that still needs work. Only `completed` is done. */
export function upgradeIsPending(item: WorkspaceUpgradeItem): boolean {
  return item.status !== "completed"
}

type UpgradeNotice = NonNullable<
  WorkspaceUpgradeItem["steps"][number]["notices"]
>[number]

/**
 * The lines that the card shows: the notices of every step, each one time,
 * with the actions first and the risks after them. Each other report line
 * stays behind Details.
 */
export function upgradeNotices(
  item: Pick<WorkspaceUpgradeItem, "steps">,
): UpgradeNotice[] {
  const seen = new Set<string>()
  const notices = item.steps
    .flatMap((step) => step.notices ?? [])
    .filter((notice) => {
      const key = `${notice.kind}\n${notice.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return [
    ...notices.filter((notice) => notice.kind === "action"),
    ...notices.filter((notice) => notice.kind === "risk"),
  ]
}

/** The owner or admin can press Start on these. */
export function upgradeCanStart(item: WorkspaceUpgradeItem): boolean {
  return item.status === "awaiting_operator" || item.status === "failed"
}

const UPGRADE_STATUS_TAG: Record<
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

type BlockedCopy = { title: string; body: string }

/**
 * The copy of a blocked item, for each item kind and block reason. The
 * title says what cannot happen. The body is the fallback when the server
 * gives no note: the note names the real cause (for example a remote that
 * is not GitHub), so it comes first.
 */
const UPGRADE_BLOCKED_COPY: Record<
  WorkspaceUpgradeItem["kind"],
  Record<string, BlockedCopy>
> = {
  format: {
    write_access: {
      title: "ctx| cannot open the upgrade pull request",
      body: "ctx| needs write access through the GitHub App to open the upgrade pull request. Connect the Workspace repository with the GitHub App, then check the Workspace again.",
    },
  },
  reingest: {
    write_access: {
      title: "ctx| cannot publish the re-ingestion",
      body: "ctx| needs write access through the GitHub App to publish the re-ingestion. Connect the Workspace repository with the GitHub App, then check the Workspace again.",
    },
    needs_format: {
      title: "Apply the format upgrade first",
      body: "The re-ingestion needs a newer repository format. Start the format upgrade and merge its pull request.",
    },
    sandbox_unavailable: {
      title: "This deployment cannot run the re-ingestion",
      body: "This ctx| deployment has no ingest sandbox. Ask the operator of ctx| to configure one.",
    },
    ingestion_v2_off: {
      title: "The re-ingestion cannot run here yet",
      body: "ctx| has not read a valid format file of this Workspace yet.",
    },
  },
}

/** The title and the reason of a blocked item. */
export function upgradeBlockedCopy(
  item: Pick<WorkspaceUpgradeItem, "kind" | "blockedReason" | "note">,
): BlockedCopy {
  const copy = item.blockedReason
    ? UPGRADE_BLOCKED_COPY[item.kind]?.[item.blockedReason]
    : undefined
  return {
    title:
      copy?.title ??
      (item.kind === "reingest"
        ? "The re-ingestion cannot start"
        : "The upgrade cannot start"),
    body: item.note ?? copy?.body ?? "ctx| cannot start this item now.",
  }
}

/** The owner or admin can press Check again on these. */
export function upgradeCanCheck(item: WorkspaceUpgradeItem): boolean {
  return (
    item.status === "pr_open" ||
    (item.kind === "reingest" &&
      item.status === "blocked" &&
      item.blockedReason === "needs_format")
  )
}

/** "12 min", "1 h 5 min" or "less than a minute". */
function waitedFor(sinceIso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 60_000))
  if (minutes < 1) return "less than a minute"
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** The status tag of an item. A run that waits for a sandbox slot says so. */
export function upgradeStatusTag(
  item: Pick<WorkspaceUpgradeItem, "status" | "waitingForSlot"> &
    Partial<Pick<WorkspaceUpgradeItem, "mergedAt" | "kind">>,
) {
  if (item.status === "pr_open" && item.mergedAt)
    return {
      label: "Merged. Reading the new format",
      className: "border-teal-400/30 bg-teal-400/10 text-teal-200",
      pulse: true,
    }
  // A re-ingestion opens no pull request while it runs.
  if (
    item.kind === "reingest" &&
    item.status === "running" &&
    !item.waitingForSlot
  )
    return { ...UPGRADE_STATUS_TAG.running, label: "Re-ingesting the sources" }
  return item.status === "running" && item.waitingForSlot
    ? { ...UPGRADE_STATUS_TAG.running, label: "Waiting for a free sandbox" }
    : UPGRADE_STATUS_TAG[item.status]
}

/** What a waiting item waits for, and what happens next. Null when it does not wait. */
export function upgradeWaitingCopy(
  item: Pick<WorkspaceUpgradeItem, "status" | "pullRequest"> &
    Partial<Pick<WorkspaceUpgradeItem, "waitingForSlot" | "mergedAt">>,
  now = Date.now(),
): string | null {
  if (item.status === "running" && item.waitingForSlot)
    return `Waiting for a free sandbox for ${waitedFor(item.waitingForSlot.since, now)}. ${item.waitingForSlot.reason} ctx| checks again every minute and starts the run when its turn comes.`
  // The progress block of a merged pull request says what ctx| does now.
  if (item.status !== "pr_open" || item.mergedAt) return null
  const pullRequest = item.pullRequest?.number
    ? `pull request #${item.pullRequest.number}`
    : "the upgrade pull request"
  return `ctx| waits for you to merge ${pullRequest} on GitHub. After the merge, ctx| reads the new format of the repository. This takes a few minutes. This page updates by itself.`
}

/** The next step of a re-ingestion that waits for the format upgrade. Null for other items. */
export function upgradeBlockedNextStep(
  item: Pick<WorkspaceUpgradeItem, "kind" | "status" | "blockedReason">,
): string | null {
  if (
    item.kind !== "reingest" ||
    item.status !== "blocked" ||
    item.blockedReason !== "needs_format"
  )
    return null
  return "Next step: merge the format upgrade pull request. After the merge, ctx| reads the new format and this item becomes ready to start. If you merged it already, press Check again."
}

/** The toast after the start of an item. A re-ingestion opens no pull request on start. */
export function upgradeStartedMessage(item: { kind: string }): string {
  return item.kind === "reingest"
    ? "The re-ingestion is queued. ctx| reads each source repository again."
    : "The upgrade is queued. ctx| prepares a pull request."
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

/** The text of the next action for a member. */
export const MEMBER_ASK_ADMIN = "Ask an admin"
