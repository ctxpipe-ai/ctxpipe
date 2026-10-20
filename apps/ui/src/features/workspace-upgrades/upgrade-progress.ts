import type { WorkspaceUpgradeItem } from "./queries"

/** The stages of a git upgrade run, in order, as the server records them. */
const FORMAT_STAGES = [
  { name: "read", label: "Reading the Workspace repository" },
  { name: "build", label: "Making the upgrade commits" },
  { name: "push", label: "Pushing the upgrade branch" },
  { name: "open", label: "Opening the pull request" },
] as const

type ProgressItem = Pick<
  WorkspaceUpgradeItem,
  | "kind"
  | "status"
  | "runStage"
  | "repositories"
  | "waitingForSlot"
  | "approvedAt"
  | "mergedAt"
>

export type UpgradeProgress = {
  /** What ctx| does now. */
  label: string
  /** "Step 2 of 4" or "1 of 3 repositories". Null when the count is not known. */
  count: string | null
  /** How far the work is, 0 to 1. Null when it is not known: the bar pulses. */
  fraction: number | null
  /** One more fact about the current work, for example the repository. */
  detail: string | null
  /** When the clock of "Time so far" began. Null when the server does not say. */
  since: string | null
}

/** "45 s", "3 min 20 s" or "1 h 5 min". */
export function formatElapsed(sinceIso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** The local time of day of a server time, for example "10:42". */
function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * The progress of an item that ctx| works on: a queued or running upgrade,
 * or a pull request that ctx| saw merge. The data comes from the upgrade row:
 * the stage of a git run, the repositories of a re-ingestion, and the times.
 * Null for an item that waits for a person, and for a re-ingestion that waits
 * for a sandbox slot (its own line says that).
 */
export function upgradeProgress(item: ProgressItem): UpgradeProgress | null {
  if (item.status === "pr_open" && item.mergedAt)
    return {
      label: "Merged. Reading the new format…",
      count: null,
      fraction: null,
      detail:
        "ctx| saw the merge. Next, ctx| reads the new format of the repository and completes this upgrade. A large repository can take several minutes.",
      since: item.mergedAt,
    }
  if (item.status !== "queued" && item.status !== "running") return null
  if (item.status === "running" && item.waitingForSlot) return null
  const since = item.approvedAt
  if (item.kind === "format") {
    const index = FORMAT_STAGES.findIndex(
      (stage) => stage.name === item.runStage?.name,
    )
    const stage = FORMAT_STAGES[index]
    if (item.status === "queued" || !stage)
      return {
        label:
          item.status === "queued"
            ? "Queued. ctx| starts the run in a moment."
            : "Starting the run",
        count: null,
        fraction: 0,
        detail: null,
        since,
      }
    return {
      label: stage.label,
      count: `Step ${index + 1} of ${FORMAT_STAGES.length}`,
      fraction: index / FORMAT_STAGES.length,
      detail: null,
      since,
    }
  }
  const total = item.repositories.length
  if (item.status === "queued" || total === 0)
    return {
      label:
        item.status === "queued"
          ? "Queued. ctx| starts the run in a moment."
          : "Planning the run",
      count: null,
      fraction: null,
      detail: null,
      since,
    }
  const finished = item.repositories.filter(
    (repository) => repository.status !== "pending",
  ).length
  const current = item.repositories.find(
    (repository) => repository.status === "pending",
  )
  return {
    label: current
      ? "Reading the source repositories"
      : "Finishing the re-ingestion",
    count: `${finished} of ${total} ${total === 1 ? "repository" : "repositories"} done`,
    fraction: finished / total,
    detail: current ? `Now: ${current.repository}` : null,
    since,
  }
}

type CheckItem = Pick<
  WorkspaceUpgradeItem,
  | "kind"
  | "status"
  | "checkedAt"
  | "mergedAt"
  | "pullRequest"
  | "blockedReason"
  | "targetFormat"
>

/**
 * What the last check found, in one line. The check is the scan that Check
 * again starts. Null before the first check, and while a run works (the run
 * has its own progress).
 */
export function upgradeCheckResult(
  item: CheckItem,
  formatVersion: number | null,
): string | null {
  if (!item.checkedAt) return null
  const at = `Last check at ${formatClock(item.checkedAt)}.`
  const number = item.pullRequest?.number
  const pullRequest = number ? `Pull request #${number}` : "The pull request"
  switch (item.status) {
    case "pr_open":
      return item.mergedAt
        ? `${at} The pull request merged. ctx| is reading the new format.`
        : `${at} ${pullRequest} is still open on GitHub. ctx| waits for the merge.`
    case "awaiting_operator":
      return `${at} ctx| found no open pull request for this upgrade.`
    case "blocked":
      return item.blockedReason === "needs_format" &&
        typeof formatVersion === "number"
        ? `${at} The Workspace uses format ${formatVersion}. This item needs format ${item.targetFormat}.`
        : `${at} This item is still blocked.`
    case "completed":
      return `${at} The upgrade is applied.`
    default:
      return null
  }
}
