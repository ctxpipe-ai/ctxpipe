import type { OrgAtlassianOauthGet } from "./queries/atlassian-connector"
import type { AtlassianConnectorStatus } from "./types"

type ConfluenceWizardStepId = "oauth_register" | "link" | "forge" | "workspaces"

type ConfluenceWizardStepDef = {
  readonly id: ConfluenceWizardStepId
  readonly label: string
}

/**
 * A connection holds auth only (ADR-050). The scope (spaces and pages) is in
 * each Workspace's sources, so the last step adds the connection to Workspaces.
 */
const CONFLUENCE_STEP_TAIL = [
  { id: "forge" as const, label: "Install Forge app" },
  { id: "workspaces" as const, label: "Add to Workspaces" },
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

/**
 * Index in the active step list that is current. After the install, it is
 * the "workspaces" step: the connection is ready, and adding it to Workspaces
 * is optional.
 */
export function getConfluenceCardCurrentIndex(
  status: AtlassianConnectorStatus,
  oauthMeta: OrgAtlassianOauthGet | undefined,
): number {
  const defs = getConfluenceCardStepDefs(oauthMeta)
  // The org connection is ready, also for a member without an Atlassian link.
  if (status.isInstalled) return stepIndex(defs, "workspaces")
  if (defs[0]?.id === "oauth_register" && !oauthMeta?.oauthAppSaved)
    return stepIndex(defs, "oauth_register")
  if (!status.isLinked) return stepIndex(defs, "link")
  return stepIndex(defs, "forge")
}

type ConfluenceWizardBodyId =
  | "oauth_register"
  | "link"
  | "install"
  | "wait"
  | "workspaces"
  | "complete"

export function getConfluenceWizardBodyId(
  status: AtlassianConnectorStatus,
  options: { waitForInstall: boolean; workspacesDone?: boolean },
  oauthMeta: OrgAtlassianOauthGet | undefined,
): ConfluenceWizardBodyId {
  const defs = getConfluenceCardStepDefs(oauthMeta)
  if (status.isInstalled)
    return options.workspacesDone ? "complete" : "workspaces"
  if (
    defs[0]?.id === "oauth_register" &&
    oauthMeta &&
    !oauthMeta.oauthAppSaved
  ) {
    return "oauth_register"
  }
  if (!status.isLinked) return "link"
  return options.waitForInstall ? "wait" : "install"
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
    case "workspaces":
      return "workspaces"
    default: {
      const _x: never = step
      return _x
    }
  }
}

/** The card action: continue setup, or none once the connection is ready. */
type ConfluenceCardPrimaryCta = { kind: "open_wizard"; label: string }

export function getConfluenceCardPrimaryCta(
  currentIndex: number,
  stepDefs: readonly ConfluenceWizardStepDef[],
): ConfluenceCardPrimaryCta {
  const step = stepDefs[currentIndex]
  switch (step?.id) {
    case "oauth_register":
      return { kind: "open_wizard", label: "Register OAuth app" }
    case "link":
      return { kind: "open_wizard", label: "Link Atlassian account" }
    case "forge":
      return { kind: "open_wizard", label: "Continue setup" }
    default:
      // The setup dialog adds a connected Confluence to more Workspaces.
      return { kind: "open_wizard", label: "Manage" }
  }
}
