type SetupStatus = {
  isInstalled?: boolean
  installationStatus?: string | null
}

type OAuthMeta = {
  globalPagerdutyOAuthConfigured: boolean
  oauthAppSaved: boolean
}

/**
 * A connection holds auth only (ADR-050): connect PagerDuty, then add it to
 * Workspaces. Each Workspace keeps its services in its sources.
 */
export const PAGERDUTY_SETUP_STEPS = [
  { id: "connect", label: "Connect PagerDuty account" },
  { id: "workspaces", label: "Add to Workspaces" },
] as const

export const PAGERDUTY_SELF_HOSTED_SETUP_STEPS = [
  { id: "register", label: "Register PagerDuty OAuth app" },
  ...PAGERDUTY_SETUP_STEPS,
] as const

export function getPagerdutySetupSteps(oauth: OAuthMeta | undefined) {
  if (!oauth || oauth.globalPagerdutyOAuthConfigured) {
    return PAGERDUTY_SETUP_STEPS
  }
  return PAGERDUTY_SELF_HOSTED_SETUP_STEPS
}

export function shouldShowPagerdutyRegisterStep(
  status: SetupStatus,
  oauth: OAuthMeta | undefined,
): boolean {
  return Boolean(
    oauth &&
    !oauth.globalPagerdutyOAuthConfigured &&
    !oauth.oauthAppSaved &&
    !status.isInstalled,
  )
}

export function getPagerdutySetupCurrentIndex(
  status: SetupStatus,
  oauth?: OAuthMeta,
): number {
  const steps = getPagerdutySetupSteps(oauth)
  const offset = steps[0]?.id === "register" ? 1 : 0
  if (!status.isInstalled) {
    return shouldShowPagerdutyRegisterStep(status, oauth) ? 0 : offset
  }
  return offset + 1
}

/** The card action while setup is not done, or null once PagerDuty is connected. */
export function getPagerdutyCardCtaLabel(
  status: SetupStatus,
  oauth?: OAuthMeta,
): string | null {
  if (status.installationStatus === "revoked") return "Reconnect PagerDuty"
  // The setup dialog adds a connected PagerDuty to more Workspaces.
  if (status.isInstalled) return "Manage"
  if (shouldShowPagerdutyRegisterStep(status, oauth))
    return "Register OAuth app"
  return "Connect PagerDuty"
}
