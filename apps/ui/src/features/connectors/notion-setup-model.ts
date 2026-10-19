type SetupStatus = {
  setupPhase: string
  isInstalled?: boolean
}

type NotionOauthMeta = {
  oauthAppSaved: boolean
  globalNotionOAuthConfigured: boolean
  webhookConfigured?: boolean
}

/**
 * A connection holds auth only (ADR-050): connect Notion, then add it to
 * Workspaces. Each Workspace keeps its pages and databases in its sources.
 */
export const NOTION_SETUP_STEPS = [
  { id: "connect", label: "Connect Notion" },
  { id: "workspaces", label: "Add to Workspaces" },
] as const

export const SELF_HOSTED_NOTION_SETUP_STEPS = [
  { id: "register", label: "Register Notion OAuth app" },
  { id: "webhook", label: "Add webhook" },
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

export function shouldShowNotionWebhookStep(
  oauthMeta?: NotionOauthMeta,
): boolean {
  return Boolean(
    oauthMeta &&
      !oauthMeta.globalNotionOAuthConfigured &&
      oauthMeta.oauthAppSaved,
  )
}

export function getNotionSetupCurrentIndex(
  status: SetupStatus,
  oauthMeta?: NotionOauthMeta,
  options: { workspacesDone?: boolean } = {},
): number {
  const steps = getNotionSetupSteps(oauthMeta)
  const selfHost = steps[0]?.id === "register"
  const offset = selfHost ? 2 : 0
  if (!status.isInstalled) {
    if (selfHost && !oauthMeta?.oauthAppSaved) return 0
    if (selfHost && !oauthMeta?.webhookConfigured) return 1
    return offset
  }
  return options.workspacesDone ? steps.length : offset + 1
}

/** The card action while setup is not done, or null once Notion is connected. */
export function getNotionCardCtaLabel(
  status: SetupStatus,
  oauthMeta?: NotionOauthMeta,
): string | null {
  // The setup dialog adds a connected Notion to more Workspaces.
  if (status.isInstalled) return "Manage"
  if (shouldShowNotionRegisterStep(oauthMeta)) return "Register OAuth app"
  if (shouldShowNotionWebhookStep(oauthMeta) && !oauthMeta?.webhookConfigured)
    return "Add webhook"
  return "Connect Notion"
}
