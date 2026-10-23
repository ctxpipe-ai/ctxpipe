import type { UpgradeStatus, WorkspaceUpgradeItem } from "./queries"

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

/**
 * The one short line of the Home toast. The full description stays in
 * Workspace settings, Status (CTX-939).
 */
export function upgradeToastLine(
  item: Pick<WorkspaceUpgradeItem, "kind" | "targetFormat">,
): string {
  return item.kind === "reingest"
    ? "ctxpipe reads each source repository again. This uses model calls."
    : `ctxpipe opens a pull request for format ${item.targetFormat}. Nothing changes until you merge it.`
}

/** The owner or admin can press Start on these. */
export function upgradeCanStart(item: WorkspaceUpgradeItem): boolean {
  return item.status === "awaiting_operator" || item.status === "failed"
}

/** The colors of a status tag: one map for the item tags and the headline. */
const STATUS_TONE = {
  attention: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  good: "border-teal-400/30 bg-teal-400/10 text-teal-200",
  neutral: "border-border bg-zinc-800 text-muted-foreground",
  error: "border-red-400/30 bg-red-400/10 text-red-200",
} as const

const UPGRADE_STATUS_TAG: Record<
  UpgradeStatus,
  { label: string; className: string; pulse?: boolean }
> = {
  awaiting_operator: {
    label: "Ready to start",
    className: STATUS_TONE.attention,
  },
  queued: { label: "Queued", className: STATUS_TONE.neutral, pulse: true },
  running: {
    label: "Preparing the pull request",
    className: STATUS_TONE.neutral,
    pulse: true,
  },
  pr_open: { label: "Waiting for merge", className: STATUS_TONE.attention },
  completed: { label: "Applied", className: STATUS_TONE.good },
  failed: { label: "Failed", className: STATUS_TONE.error },
  blocked: { label: "Blocked", className: STATUS_TONE.attention },
}

/**
 * The tag of a blocked item in Working now: it waits for ctxpipe, for
 * example for the format upgrade that ctxpipe reads now.
 */
export const UPGRADE_WAITS_TAG = {
  label: "Waiting",
  className: STATUS_TONE.neutral,
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
      title: "ctxpipe cannot open the upgrade pull request",
      body: "ctxpipe needs write access through the GitHub App to open the upgrade pull request. Connect the Workspace repository with the GitHub App, then check the Workspace again.",
    },
  },
  reingest: {
    write_access: {
      title: "ctxpipe cannot publish the re-ingestion",
      body: "ctxpipe needs write access through the GitHub App to publish the re-ingestion. Connect the Workspace repository with the GitHub App, then check the Workspace again.",
    },
    needs_format: {
      title: "Apply the format upgrade first",
      body: "Re-ingestion needs a newer format. Finish the format upgrade, then press Check again.",
    },
    sandbox_unavailable: {
      title: "This deployment cannot run the re-ingestion",
      body: "This ctxpipe deployment has no ingest sandbox. Ask the operator of ctxpipe to configure one.",
    },
    ingestion_v2_off: {
      title: "The re-ingestion cannot run here yet",
      body: "ctxpipe has not read a valid format file of this Workspace yet.",
    },
  },
}

/** The title and the short reason of a blocked item. */
export function upgradeBlockedCopy(
  item: Pick<
    WorkspaceUpgradeItem,
    "kind" | "blockedReason" | "note" | "targetFormat"
  >,
): BlockedCopy {
  const copy = item.blockedReason
    ? UPGRADE_BLOCKED_COPY[item.kind]?.[item.blockedReason]
    : undefined
  // The note of this reason can name two actions. The format upgrade card
  // names the real cause and its fix (merge the pull request, or give write
  // access), so this item says one action.
  if (item.blockedReason === "needs_format" && copy)
    return {
      title: copy.title,
      body: `Re-ingestion needs format ${item.targetFormat}. Finish the format upgrade, then press Check again.`,
    }
  return {
    title:
      copy?.title ??
      (item.kind === "reingest"
        ? "The re-ingestion cannot start"
        : "The upgrade cannot start"),
    body: item.note ?? copy?.body ?? "ctxpipe cannot start this item now.",
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
  item: Pick<
    WorkspaceUpgradeItem,
    "kind" | "status" | "blockedReason" | "targetFormat" | "waitingForSlot"
  > &
    Partial<Pick<WorkspaceUpgradeItem, "mergedAt">>,
  formatVersion?: number | null,
) {
  if (item.status === "pr_open" && item.mergedAt)
    return {
      label: "Merged. Reading the new format",
      className: STATUS_TONE.good,
      pulse: true,
    }
  if (upgradeIsCheckingFormat(item, formatVersion))
    return {
      label: "Checking the new format",
      className: STATUS_TONE.neutral,
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
    return `Waiting for a free sandbox for ${waitedFor(item.waitingForSlot.since, now)}. ${item.waitingForSlot.reason} ctxpipe checks again every minute and starts the run when its turn comes.`
  // The progress block of a merged pull request says what ctxpipe does now.
  if (item.status !== "pr_open" || item.mergedAt) return null
  const pullRequest = item.pullRequest?.number
    ? `pull request #${item.pullRequest.number}`
    : "the upgrade pull request"
  return `ctxpipe waits for you to merge ${pullRequest} on GitHub. After the merge, ctxpipe reads the new format of the repository. This takes a few minutes. This page updates by itself.`
}

/**
 * A re-ingestion that the server still records as blocked for the format,
 * while the Workspace already has the format that it needs. The hydrate
 * writes the new format first. The upgrade scan runs after the hydrate and
 * writes the item. Until then, the item is stale: ctxpipe is checking.
 */
export function upgradeIsCheckingFormat(
  item: Pick<
    WorkspaceUpgradeItem,
    "kind" | "status" | "blockedReason" | "targetFormat"
  >,
  formatVersion: number | null | undefined,
): boolean {
  return (
    item.kind === "reingest" &&
    item.status === "blocked" &&
    item.blockedReason === "needs_format" &&
    typeof formatVersion === "number" &&
    formatVersion >= item.targetFormat
  )
}

/** The line of an item that waits for the scan to read the new format. */
export const CHECKING_FORMAT_COPY =
  "ctxpipe is checking the new format of the repository. This takes a minute. This page updates by itself."

/** The toast after the start of an item. A re-ingestion opens no pull request on start. */
export function upgradeStartedMessage(item: { kind: string }): string {
  return item.kind === "reingest"
    ? "The re-ingestion is queued. ctxpipe reads each source repository again."
    : "The upgrade is queued. ctxpipe prepares a pull request."
}

/** The health line: the format of the repository against the format ctxpipe reads. */
export function formatHealthLine(
  formatVersion: number | null,
  codeFormat: number,
): string {
  if (formatVersion === null)
    return "ctxpipe has not read the repository format."
  if (formatVersion < 0)
    return "The format file in the repository is not valid. Fix .ctxpipe/workspace.yaml: it must hold format, an integer of 0 or more."
  if (formatVersion > codeFormat)
    return `The repository uses format ${formatVersion}. ctxpipe reads format ${codeFormat}. This Workspace needs a newer ctxpipe version. Ask the operator of ctxpipe to update it.`
  // Up to date: the format is meta text, not a status (CTX-980).
  if (formatVersion === codeFormat) return `Format ${formatVersion}`
  return `The repository uses format ${formatVersion}. ctxpipe reads format ${codeFormat}.`
}

/** The text of the next action for a member. */
export const MEMBER_ASK_ADMIN = "Ask an admin"

type UpgradeGroup = "needs_you" | "working" | "done"

/**
 * The group of an item in the Status group (CTX-980). `needs_you`: the item
 * waits for a person (start, merge, a fix). `working`: ctxpipe works on it, or
 * waits for ctxpipe, and nobody must act. `done`: applied.
 */
export function upgradeGroup(
  item: Pick<
    WorkspaceUpgradeItem,
    "kind" | "status" | "blockedReason" | "targetFormat" | "mergedAt"
  >,
  formatVersion: number | null,
): UpgradeGroup {
  if (item.status === "completed") return "done"
  if (
    item.status === "queued" ||
    item.status === "running" ||
    (item.status === "pr_open" && item.mergedAt) ||
    upgradeIsCheckingFormat(item, formatVersion) ||
    // ctxpipe has not read the format of the tip yet: a wait on ctxpipe. A
    // format file that is not valid needs you through the format health.
    (item.status === "blocked" && item.blockedReason === "ingestion_v2_off")
  )
    return "working"
  return "needs_you"
}

/**
 * The items of the Status group in their groups, in one pass. A checking
 * state in `expired` is older than a minute: it is blocked again. A
 * re-ingestion that waits for the format, while a format item is open, goes
 * in the group of that format item and does not count: the format item is
 * the one thing to do. `count` gives the items that the headline counts.
 */
export function upgradeGroups(
  items: WorkspaceUpgradeItem[],
  formatVersion: number | null,
  expired: ReadonlySet<string>,
) {
  const own = (item: WorkspaceUpgradeItem) =>
    upgradeGroup(item, expired.has(item.key) ? null : formatVersion)
  const format = items.find(
    (item) => item.kind === "format" && item.status !== "completed",
  )
  const lists: Record<UpgradeGroup, WorkspaceUpgradeItem[]> = {
    needs_you: [],
    working: [],
    done: [],
  }
  const groupOf = new Map<string, UpgradeGroup>()
  const count = { needs_you: 0, working: 0 }
  for (const item of items) {
    const follows =
      format !== undefined &&
      item.kind === "reingest" &&
      item.status === "blocked" &&
      item.blockedReason === "needs_format" &&
      own(item) === "needs_you"
    const group = follows ? own(format) : own(item)
    lists[group].push(item)
    groupOf.set(item.key, group)
    if (!follows && group !== "done") count[group]++
  }
  return { lists, groupOf, count }
}

const items = (count: number) => `${count} ${count === 1 ? "item" : "items"}`

/**
 * The headline of the Status group: the most urgent state. Its line is the
 * first line of the group and says if the user must act. The format health
 * counts too: a format file that ctxpipe cannot read needs you, and a format
 * below the newest with no item means that ctxpipe checks the repository.
 */
export function upgradeHeadline(input: {
  count: { needs_you: number; working: number }
  formatVersion: number | null
  codeFormat: number
}): { label: string; className: string; pulse?: boolean; line: string } {
  const { formatVersion, codeFormat } = input
  const unreadable =
    formatVersion !== null && (formatVersion < 0 || formatVersion > codeFormat)
  const needsYou = input.count.needs_you + (unreadable ? 1 : 0)
  if (needsYou > 0)
    return {
      label: "Needs you",
      className: STATUS_TONE.attention,
      line: `Action needed. ${items(needsYou)} ${needsYou === 1 ? "needs" : "need"} you.`,
    }
  if (input.count.working > 0)
    return {
      label: "Working",
      className: STATUS_TONE.good,
      pulse: true,
      line: `No action needed. ctxpipe works on ${items(input.count.working)} now.`,
    }
  if (formatVersion !== null && formatVersion < codeFormat)
    return {
      label: "Working",
      className: STATUS_TONE.good,
      pulse: true,
      line: "No action needed. ctxpipe checks the format of the repository now.",
    }
  return {
    label: "Up to date",
    className: STATUS_TONE.good,
    line: "No action needed. Upgrades show here and on Home when one is ready.",
  }
}

/**
 * The spend of a re-ingestion: the sum of the known spend of its
 * repositories. "At least" when a model step reported no usage. Null when
 * ctxpipe knows no spend.
 */
export function upgradeSpendLine(
  item: Pick<WorkspaceUpgradeItem, "kind" | "repositories" | "status">,
): string | null {
  if (item.kind !== "reingest") return null
  const known = item.repositories.flatMap((repository) =>
    repository.spendUsd === null ? [] : [repository.spendUsd],
  )
  if (known.length === 0) return null
  const total = known.reduce((sum, spend) => sum + spend, 0)
  const unknown = item.repositories.some(
    (repository) => repository.spendUnknown,
  )
  // An applied re-ingestion spends no more.
  const label = item.status === "completed" ? "Spend" : "Spend so far"
  return `${label}: ${unknown ? "at least " : ""}$${total.toFixed(2)}`
}

/** The History label: the count of applied items and the date of the last one. */
export function upgradeHistoryLine(
  applied: Pick<WorkspaceUpgradeItem, "updatedAt">[],
): string {
  const last = Math.max(...applied.map((item) => Date.parse(item.updatedAt)))
  // An absolute date in one zone: the same day for each user and each test.
  const date = new Date(last).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  return `History · ${applied.length} applied, last on ${date}`
}

/** The intro of the Status group. It shows only while an item is open. */
export const STATUS_INTRO =
  "ctxpipe keeps this Workspace current. Some upgrades open a pull request for you to merge. Others run here and use model calls."
