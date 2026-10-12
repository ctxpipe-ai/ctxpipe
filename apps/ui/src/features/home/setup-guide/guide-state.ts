import type { OrgGuidePreferences } from "@/lib/user-preferences"

/** Owners and admins get the admin rows. Members get the member rows. */
export type GuideRole = "admin" | "member"

export type GuideRowId =
  | "github"
  | "workspace"
  | "repositories"
  | "ask"
  | "tool"
  | "invite"
  | "explore"

/** Real data only. No click marks a row done. */
export type GuideSignals = {
  role: GuideRole
  githubLinked: boolean
  workspaceCount: number
  /** The landing Workspace still builds its knowledge repository. */
  landingBuilding: boolean
  /** The landing Workspace has at least one linked code repository. */
  linkedRepositories: boolean
  /** The user sent a message in a Workspace of this organization. */
  asked: boolean
  /** A connection other than GitHub exists. */
  toolConnected: boolean
  /** An invitation exists, or the organization has more than one member. */
  teamInvited: boolean
  /** The user opened a Workspace pane. */
  explored: boolean
}

export type GuideRow = {
  id: GuideRowId
  done: boolean
  /** Workspace row only: the knowledge repository is still building. */
  building?: boolean
}

/** The rows of the guide. Each row counts toward progress. */
export function guideRows(signals: GuideSignals): GuideRow[] {
  const hasWorkspace = signals.workspaceCount > 0
  const workspace: GuideRow = {
    id: "workspace",
    done: hasWorkspace,
    building: hasWorkspace && signals.landingBuilding,
  }
  const ask: GuideRow = { id: "ask", done: signals.asked }
  if (signals.role === "member") {
    return [
      ...(hasWorkspace ? [] : [workspace]),
      ask,
      { id: "explore", done: signals.explored },
    ]
  }
  return [
    { id: "github", done: signals.githubLinked },
    workspace,
    { id: "repositories", done: signals.linkedRepositories },
    ask,
    { id: "tool", done: signals.toolConnected },
    { id: "invite", done: signals.teamInvited },
  ]
}

/** The guide and the hints are for users who finished onboarding recently. */
const GUIDE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export function isWithinGuideWindow(
  onboardingCompletedAt: Date | string | null | undefined,
  now: number,
): boolean {
  if (!onboardingCompletedAt) return false
  const at = new Date(onboardingCompletedAt).getTime()
  return !Number.isNaN(at) && now - at <= GUIDE_WINDOW_MS
}

export type GuideView =
  | { kind: "hidden" }
  /** `record`: store `completedAt` now, the first load that shows this line. */
  | { kind: "complete"; record: boolean }
  | {
      kind: "open"
      collapsed: boolean
      done: number
      total: number
      next: GuideRowId
    }

/**
 * Lifecycle: expanded until the user asks a first question, then collapsed.
 * The user's own toggle wins. Removed after a dismiss, after the load that
 * first showed the complete line, and 14 days after onboarding.
 */
export function guideView(input: {
  rows: GuideRow[]
  prefs: OrgGuidePreferences
  onboardingCompletedAt: Date | string | null | undefined
  now: number
  /** When this app load started. */
  appBootAt: number
}): GuideView {
  const { rows, prefs } = input
  if (prefs.dismissedAt) return { kind: "hidden" }
  if (!isWithinGuideWindow(input.onboardingCompletedAt, input.now))
    return { kind: "hidden" }
  const next = rows.find((row) => !row.done)
  if (!next) {
    if (!prefs.completedAt) return { kind: "complete", record: true }
    return Date.parse(prefs.completedAt) < input.appBootAt
      ? { kind: "hidden" }
      : { kind: "complete", record: false }
  }
  const asked = rows.some((row) => row.id === "ask" && row.done)
  return {
    kind: "open",
    collapsed: prefs.collapsed ?? asked,
    done: rows.filter((row) => row.done).length,
    total: rows.length,
    next: next.id,
  }
}
