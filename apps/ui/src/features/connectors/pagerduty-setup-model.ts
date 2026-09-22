type SetupStatus = {
  setupPhase: string
  selectedServiceCount: number | null
  pendingConfigPullUrl?: string | null
  pendingConfigPrCreating?: boolean
  isInstalled?: boolean
  isGithubLinked?: boolean
  syncTargetConfigured?: boolean
  installationStatus?: string | null
}

type OAuthMeta = {
  globalPagerdutyOAuthConfigured: boolean
  oauthAppSaved: boolean
}

type SetupProgressStatus = SetupStatus & {
  isInstalled: boolean
  isGithubLinked: boolean
  syncTargetConfigured: boolean
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating?: boolean
}

export const PAGERDUTY_CONNECT_AND_TAIL_STEPS = [
  { id: "connect", label: "Connect PagerDuty account" },
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Choose PagerDuty services" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export const PAGERDUTY_HOSTED_SETUP_STEPS = PAGERDUTY_CONNECT_AND_TAIL_STEPS

export const PAGERDUTY_SELF_HOSTED_SETUP_STEPS = [
  { id: "register", label: "Register PagerDuty OAuth app" },
  ...PAGERDUTY_CONNECT_AND_TAIL_STEPS,
] as const

/** Hosted fallback: first step is Connect. Prefer `getPagerdutySetupSteps`. */
export const PAGERDUTY_SETUP_STEPS = PAGERDUTY_HOSTED_SETUP_STEPS

export type PagerdutySetupStepDef =
  | (typeof PAGERDUTY_SELF_HOSTED_SETUP_STEPS)[number]
  | (typeof PAGERDUTY_HOSTED_SETUP_STEPS)[number]

export function getPagerdutySetupSteps(
  oauth: OAuthMeta | undefined,
): readonly PagerdutySetupStepDef[] {
  if (!oauth || oauth.globalPagerdutyOAuthConfigured) {
    return PAGERDUTY_HOSTED_SETUP_STEPS
  }
  return PAGERDUTY_SELF_HOSTED_SETUP_STEPS
}

export type PagerdutyFailureAction = "retry_config" | "retry_content"

export function getPagerdutyFailureAction(
  status: Pick<SetupStatus, "setupPhase">,
): PagerdutyFailureAction | null {
  if (status.setupPhase === "sync_failed") return "retry_content"
  if (status.setupPhase === "config_failed") return "retry_config"
  return null
}

function stepIndex(
  defs: readonly PagerdutySetupStepDef[],
  id: PagerdutySetupStepDef["id"],
): number {
  const i = defs.findIndex((step) => step.id === id)
  if (i < 0) throw new Error(`missing step id ${id}`)
  return i
}

export function getPagerdutySetupCurrentIndex(
  status: SetupProgressStatus,
  oauth?: OAuthMeta,
): number {
  const defs = getPagerdutySetupSteps(oauth)
  const registerFirst = defs[0]?.id === "register"

  if (registerFirst && !oauth?.oauthAppSaved && !status.isInstalled) {
    return stepIndex(defs, "register")
  }
  if (!status.isInstalled) return stepIndex(defs, "connect")
  if (!status.isGithubLinked) return stepIndex(defs, "github")
  if (!status.syncTargetConfigured) return stepIndex(defs, "target")
  if (
    status.setupPhase === "config_failed" &&
    !status.pendingConfigPullUrl &&
    !status.pendingConfigPrCreating
  ) {
    return stepIndex(defs, "scope")
  }
  if (
    status.pendingConfigPrCreating ||
    status.pendingConfigPullUrl ||
    status.setupPhase === "awaiting_merge" ||
    status.setupPhase === "config_failed" ||
    status.setupPhase === "initial_sync" ||
    status.setupPhase === "sync_failed"
  ) {
    return stepIndex(defs, "merge")
  }
  if (status.setupPhase === "live") return defs.length
  return stepIndex(defs, "scope")
}

export function getPagerdutyCardCtaLabel(
  status: SetupStatus,
  oauth?: OAuthMeta,
): string {
  if (getPagerdutyFailureAction(status)) return "Review failure"
  if (status.setupPhase === "live") return "Manage scope"
  if (status.installationStatus === "revoked") return "Reconnect PagerDuty"
  if (status.isInstalled === false) {
    if (
      oauth &&
      !oauth.globalPagerdutyOAuthConfigured &&
      !oauth.oauthAppSaved
    ) {
      return "Register OAuth app"
    }
    return "Connect PagerDuty"
  }
  if (status.isGithubLinked === false) return "Link GitHub"
  if (status.syncTargetConfigured === false) return "Select repository"
  if (
    status.pendingConfigPrCreating ||
    status.pendingConfigPullUrl ||
    status.setupPhase === "awaiting_merge" ||
    status.setupPhase === "initial_sync"
  ) {
    return "Continue setup"
  }
  return "Choose services"
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
