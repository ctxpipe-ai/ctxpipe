type SetupStatus = {
  setupPhase: string
  selectedServiceCount: number | null
  pendingConfigPullUrl?: string | null
  pendingConfigPrCreating?: boolean
}

type SetupProgressStatus = SetupStatus & {
  isGithubLinked: boolean
  syncTargetConfigured: boolean
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating?: boolean
}

export const PAGERDUTY_SETUP_STEPS = [
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Choose PagerDuty services" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export type PagerdutyFailureAction = "retry_config" | "retry_content"

export function getPagerdutyFailureAction(
  status: Pick<SetupStatus, "setupPhase">,
): PagerdutyFailureAction | null {
  if (status.setupPhase === "sync_failed") return "retry_content"
  if (status.setupPhase === "config_failed") return "retry_config"
  return null
}

export function getPagerdutySetupCurrentIndex(
  status: SetupProgressStatus,
): number {
  if (!status.isGithubLinked) return 0
  if (!status.syncTargetConfigured) return 1
  if (
    status.setupPhase === "config_failed" &&
    !status.pendingConfigPullUrl &&
    !status.pendingConfigPrCreating
  ) {
    return 2
  }
  if (
    status.pendingConfigPrCreating ||
    status.pendingConfigPullUrl ||
    status.setupPhase === "awaiting_merge" ||
    status.setupPhase === "config_failed" ||
    status.setupPhase === "initial_sync" ||
    status.setupPhase === "sync_failed"
  ) {
    return 3
  }
  if (status.setupPhase === "live") return PAGERDUTY_SETUP_STEPS.length
  return 2
}

export function getPagerdutyCardCtaLabel(status: SetupStatus): string {
  if (getPagerdutyFailureAction(status)) return "Review failure"
  if (status.setupPhase === "live") return "Manage scope"
  if (
    status.pendingConfigPrCreating ||
    status.pendingConfigPullUrl ||
    status.setupPhase === "awaiting_merge" ||
    status.setupPhase === "initial_sync"
  ) {
    return "Continue setup"
  }
  return "Set up"
}

function serviceKeys(services: Array<{ id: string }>): string[] {
  return [...services.map((service) => service.id)].sort()
}

export function hasPagerdutyScopeChanged(
  saved: Array<{ id: string }>,
  selected: Array<{ id: string }>,
): boolean {
  return (
    JSON.stringify(serviceKeys(saved)) !== JSON.stringify(serviceKeys(selected))
  )
}

export function shouldShowPagerdutySetupComplete(
  status: SetupStatus,
  manageScope: boolean,
): boolean {
  return !manageScope && status.setupPhase === "live"
}
