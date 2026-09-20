import type { NotionResource } from "./types"

type SetupStatus = {
  setupPhase: string
  selectedResourceCount: number | null
  pendingConfigPullUrl?: string | null
  pendingConfigPrCreating?: boolean
}

type SetupProgressStatus = SetupStatus & {
  isGithubLinked: boolean
  syncTargetConfigured: boolean
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating?: boolean
  isInstalled?: boolean
}

export type NotionOauthMeta = {
  oauthAppSaved: boolean
  globalNotionOAuthConfigured: boolean
}

export const NOTION_SETUP_STEPS = [
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Choose Notion content" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export const SELF_HOSTED_NOTION_SETUP_STEPS = [
  { id: "register", label: "Register Notion integration" },
  ...NOTION_SETUP_STEPS,
] as const

export function getNotionSetupSteps(oauthMeta?: NotionOauthMeta) {
  if (!oauthMeta || oauthMeta.globalNotionOAuthConfigured) {
    return NOTION_SETUP_STEPS
  }
  return SELF_HOSTED_NOTION_SETUP_STEPS
}

export function shouldShowNotionRegisterStep(
  oauthMeta?: NotionOauthMeta,
): boolean {
  return Boolean(
    oauthMeta &&
      !oauthMeta.globalNotionOAuthConfigured &&
      !oauthMeta.oauthAppSaved,
  )
}

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
  oauthMeta?: NotionOauthMeta,
): number {
  const offset =
    getNotionSetupSteps(oauthMeta)[0]?.id === "register" ? 1 : 0
  if (offset === 1 && status.isInstalled === false) {
    return 0
  }
  if (!status.isGithubLinked) return offset
  if (!status.syncTargetConfigured) return 1 + offset
  // Pre-PR config failure has no git draft — resubmit resources.
  if (
    status.setupPhase === "config_failed" &&
    !status.pendingConfigPullUrl &&
    !status.pendingConfigPrCreating
  ) {
    return 2 + offset
  }
  // Git scope is loaded only inside setup. Status polling must stay DB-only, so
  // the count is null and lifecycle state drives progress here.
  if (
    status.pendingConfigPrCreating ||
    status.pendingConfigPullUrl ||
    status.setupPhase === "awaiting_merge" ||
    status.setupPhase === "config_failed" ||
    status.setupPhase === "initial_sync" ||
    status.setupPhase === "sync_failed"
  ) {
    return 3 + offset
  }
  if (status.setupPhase === "live") {
    return getNotionSetupSteps(oauthMeta).length
  }
  return 2 + offset
}

export function getNotionCardCtaLabel(
  status: SetupStatus,
  oauthMeta?: NotionOauthMeta,
): string {
  if (status.setupPhase === "draft") {
    if (shouldShowNotionRegisterStep(oauthMeta)) {
      return "Register integration"
    }
    if (oauthMeta && !oauthMeta.globalNotionOAuthConfigured && oauthMeta.oauthAppSaved) {
      return "Connect Notion"
    }
  }
  if (getNotionFailureAction(status)) return "Review failure"
  if (status.setupPhase === "live") {
    return "Manage scope"
  }
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
  return !manageScope && status.setupPhase === "live"
}
