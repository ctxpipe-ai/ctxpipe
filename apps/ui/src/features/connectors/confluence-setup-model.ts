import type { OrgAtlassianOauthGet } from "./queries/atlassian-connector"
import type { AtlassianConnectorStatus } from "./types"

export type ConfluenceWizardStepId =
  | "oauth_register"
  | "link"
  | "forge"
  | "github"
  | "target"
  | "scope"
  | "merge"

export type ConfluenceWizardStepDef = {
  readonly id: ConfluenceWizardStepId
  readonly label: string
}

const CONFLUENCE_STEP_TAIL = [
  { id: "forge" as const, label: "Install Forge app" },
  { id: "github" as const, label: "Link GitHub account" },
  { id: "target" as const, label: "Select sync repository" },
  { id: "scope" as const, label: "Configure Confluence scope" },
  { id: "merge" as const, label: "Approve configuration in GitHub" },
] as const satisfies readonly ConfluenceWizardStepDef[]

/** Managed cloud: server supplies the Atlassian OAuth app — no per-org registration step. */
export const MANAGED_CONFLUENCE_WIZARD_STEPS: readonly ConfluenceWizardStepDef[] =
  [{ id: "link", label: "Link Atlassian account" }, ...CONFLUENCE_STEP_TAIL]

/** Self-hosted: org registers its own 3LO app before linking an account. */
export const SELF_HOSTED_CONFLUENCE_WIZARD_STEPS: readonly ConfluenceWizardStepDef[] =
  [
    {
      id: "oauth_register",
      label: "Register Atlassian OAuth app",
    },
    { id: "link", label: "Link Atlassian account" },
    ...CONFLUENCE_STEP_TAIL,
  ]

export function getConfluenceCardStepDefs(
  oauthMeta: OrgAtlassianOauthGet | undefined,
): readonly ConfluenceWizardStepDef[] {
  if (!oauthMeta || oauthMeta.globalAtlassianOAuthConfigured) {
    return MANAGED_CONFLUENCE_WIZARD_STEPS
  }
  return SELF_HOSTED_CONFLUENCE_WIZARD_STEPS
}

function stepIndex(
  defs: readonly ConfluenceWizardStepDef[],
  id: ConfluenceWizardStepId,
): number {
  const i = defs.findIndex((d) => d.id === id)
  if (i < 0) throw new Error(`missing step id ${id}`)
  return i
}

/** Index in the active step list that is current, or `length` when all steps are done. */
export function getConfluenceCardCurrentIndex(
  status: AtlassianConnectorStatus,
  oauthMeta: OrgAtlassianOauthGet | undefined,
): number {
  const defs = getConfluenceCardStepDefs(oauthMeta)
  const registerFirst = defs[0]?.id === "oauth_register"

  if (registerFirst) {
    if (!oauthMeta?.oauthAppSaved) return stepIndex(defs, "oauth_register")
    if (!status.isLinked) return stepIndex(defs, "link")
    if (!status.isInstalled) return stepIndex(defs, "forge")
    if (!status.isGithubLinked) return stepIndex(defs, "github")
    if (!status.syncTargetConfigured) return stepIndex(defs, "target")
    if (status.selectedSpaceCount === 0) return stepIndex(defs, "scope")
    if (status.setupPhase === "live") return defs.length
    return stepIndex(defs, "merge")
  }

  if (!status.isLinked) return stepIndex(defs, "link")
  if (!status.isInstalled) return stepIndex(defs, "forge")
  if (!status.isGithubLinked) return stepIndex(defs, "github")
  if (!status.syncTargetConfigured) return stepIndex(defs, "target")
  if (status.selectedSpaceCount === 0) return stepIndex(defs, "scope")
  if (status.setupPhase === "live") return defs.length
  return stepIndex(defs, "merge")
}

export type ConfluenceWizardBodyId =
  | "oauth_register"
  | "link"
  | "install"
  | "wait"
  | "github"
  | "target"
  | "scope"
  | "merge"
  | "complete"

export function getConfluenceWizardBodyId(
  status: AtlassianConnectorStatus,
  options: { waitForInstall: boolean },
  oauthMeta: OrgAtlassianOauthGet | undefined,
): ConfluenceWizardBodyId {
  const defs = getConfluenceCardStepDefs(oauthMeta)
  if (
    defs[0]?.id === "oauth_register" &&
    oauthMeta &&
    !oauthMeta.oauthAppSaved
  ) {
    return "oauth_register"
  }
  if (!status.isLinked) return "link"
  if (!status.isInstalled) {
    return options.waitForInstall ? "wait" : "install"
  }
  if (!status.isGithubLinked) return "github"
  if (!status.syncTargetConfigured) return "target"
  if (status.selectedSpaceCount === 0) return "scope"
  if (status.setupPhase !== "live") return "merge"
  return "complete"
}

/** Wizard panel for a specific card step index (used when revisiting a previous step). */
export function getConfluenceWizardBodyIdForStepIndex(
  stepIndex: number,
  status: AtlassianConnectorStatus,
  options: { waitForInstall: boolean },
  oauthMeta: OrgAtlassianOauthGet | undefined,
): ConfluenceWizardBodyId {
  const defs = getConfluenceCardStepDefs(oauthMeta)
  const step = defs[stepIndex]
  if (!step) return "complete"

  switch (step.id) {
    case "oauth_register":
      return "oauth_register"
    case "link":
      return "link"
    case "forge":
      if (!status.isInstalled) {
        return options.waitForInstall ? "wait" : "install"
      }
      return "install"
    case "github":
      return "github"
    case "target":
      return "target"
    case "scope":
      return "scope"
    case "merge":
      return "merge"
    default: {
      const _x: never = step
      return _x
    }
  }
}

export type ConfluenceCardPrimaryCta =
  | { kind: "open_wizard"; label: string }
  | { kind: "navigate_repositories"; label: string }
  | { kind: "open_scope"; label: string }

export function getConfluenceCardPrimaryCta(
  currentIndex: number,
  stepDefs: readonly ConfluenceWizardStepDef[],
): ConfluenceCardPrimaryCta {
  if (currentIndex >= stepDefs.length) {
    return { kind: "open_scope", label: "Manage scope" }
  }
  const step = stepDefs[currentIndex]
  if (!step) {
    return { kind: "open_scope", label: "Manage scope" }
  }
  switch (step.id) {
    case "oauth_register":
      return { kind: "open_wizard", label: "Register OAuth app" }
    case "link":
      return { kind: "open_wizard", label: "Link Atlassian account" }
    case "forge":
      return { kind: "open_wizard", label: "Continue setup" }
    case "github":
      return { kind: "navigate_repositories", label: "Link GitHub" }
    case "target":
      return { kind: "open_wizard", label: "Select repository" }
    case "scope":
    case "merge":
      return { kind: "open_scope", label: "Configure scope" }
    default: {
      const _x: never = step
      return _x
    }
  }
}

export function hasConfluenceConnectionRow(
  status: AtlassianConnectorStatus | undefined,
): boolean {
  if (!status) return false
  return Boolean(
    status.isLinked || status.isInstalled || status.installationStatus != null,
  )
}
