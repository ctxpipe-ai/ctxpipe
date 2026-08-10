import type { NotionResource } from "./types"

type SetupStatus = {
  setupPhase: string
  selectedResourceCount: number
}

type SetupProgressStatus = SetupStatus & {
  isGithubLinked: boolean
  syncTargetConfigured: boolean
  pendingConfigPullUrl: string | null
}

export const NOTION_SETUP_STEPS = [
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Choose Notion content" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export type NotionFailureAction = "retry_config" | "retry_content"

export function getNotionFailureAction(
  status: Pick<SetupStatus, "setupPhase">,
): NotionFailureAction | null {
  if (status.setupPhase === "sync_failed") return "retry_content"
  if (status.setupPhase === "config_failed") return "retry_config"
  return null
}

export function getNotionSetupCurrentIndex(
  status: SetupProgressStatus,
): number {
  if (!status.isGithubLinked) return 0
  if (!status.syncTargetConfigured) return 1
  if (
    status.setupPhase === "config_failed" &&
    status.selectedResourceCount === 0 &&
    !status.pendingConfigPullUrl
  ) {
    return 2
  }
  if (getNotionFailureAction(status)) return 3
  if (status.selectedResourceCount === 0) return 2
  if (status.setupPhase === "live") return NOTION_SETUP_STEPS.length
  return 3
}

export function getNotionCardCtaLabel(status: SetupStatus): string {
  if (getNotionFailureAction(status)) return "Review failure"
  return status.setupPhase === "live" && status.selectedResourceCount > 0
    ? "Manage scope"
    : "Set up"
}

function scopeKeys(resources: NotionResource[]): string[] {
  return resources
    .map((resource) => `${resource.type}:${resource.externalId}`)
    .sort()
}

export function hasNotionScopeChanged(
  saved: NotionResource[],
  selected: NotionResource[],
): boolean {
  return (
    JSON.stringify(scopeKeys(saved)) !== JSON.stringify(scopeKeys(selected))
  )
}

export function shouldShowNotionSetupComplete(
  status: SetupStatus,
  manageScope: boolean,
): boolean {
  return (
    !manageScope &&
    status.setupPhase === "live" &&
    status.selectedResourceCount > 0
  )
}
