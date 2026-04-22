import type { AtlassianConnectorStatus } from "./types"

export const CONFLUENCE_CARD_STEP_DEFS = [
  { id: "link" as const, label: "Link Atlassian account" },
  { id: "forge" as const, label: "Install Forge app" },
  { id: "github" as const, label: "Link GitHub account" },
  { id: "target" as const, label: "Select sync repository" },
  { id: "scope" as const, label: "Configure Confluence scope" },
]

export type ConfluenceCardStepId =
  (typeof CONFLUENCE_CARD_STEP_DEFS)[number]["id"]

/** Index in `CONFLUENCE_CARD_STEP_DEFS` that is current, or `length` when all steps are done. */
export function getConfluenceCardCurrentIndex(
  status: AtlassianConnectorStatus,
): number {
  if (!status.isLinked) return 0
  if (!status.isInstalled) return 1
  if (!status.isGithubLinked) return 2
  if (!status.syncTargetConfigured) return 3
  if (status.selectedSpaceCount === 0) return 4
  return CONFLUENCE_CARD_STEP_DEFS.length
}

export type ConfluenceWizardBodyId =
  | "link"
  | "install"
  | "wait"
  | "install_success"
  | "github"
  | "target"
  | "complete"

export function getConfluenceWizardBodyId(
  status: AtlassianConnectorStatus,
  options: { waitForInstall: boolean; showInstallSuccess: boolean },
): ConfluenceWizardBodyId {
  if (!status.isLinked) return "link"
  if (!status.isInstalled) {
    return options.waitForInstall ? "wait" : "install"
  }
  if (options.showInstallSuccess && !status.syncTargetConfigured) {
    return "install_success"
  }
  if (!status.isGithubLinked) return "github"
  if (!status.syncTargetConfigured) return "target"
  return "complete"
}

/** Wizard panel for a specific card step index (used when revisiting a previous step). */
export function getConfluenceWizardBodyIdForStepIndex(
  stepIndex: number,
  status: AtlassianConnectorStatus,
  options: { waitForInstall: boolean; showInstallSuccess: boolean },
): ConfluenceWizardBodyId {
  if (stepIndex <= 0) return "link"
  if (stepIndex === 1) {
    if (!status.isInstalled) {
      return options.waitForInstall ? "wait" : "install"
    }
    if (options.showInstallSuccess && !status.syncTargetConfigured) {
      return "install_success"
    }
    return "install"
  }
  if (stepIndex === 2) return "github"
  if (stepIndex === 3) return "target"
  return "complete"
}

export type ConfluenceCardPrimaryCta =
  | { kind: "open_wizard"; label: string }
  | { kind: "navigate_repositories"; label: string }
  | { kind: "open_scope"; label: string }

export function getConfluenceCardPrimaryCta(
  currentIndex: number,
): ConfluenceCardPrimaryCta {
  if (currentIndex >= CONFLUENCE_CARD_STEP_DEFS.length) {
    return { kind: "open_scope", label: "Manage scope" }
  }
  if (currentIndex === 0) {
    return { kind: "open_wizard", label: "Link Atlassian account" }
  }
  if (currentIndex === 1) {
    return { kind: "open_wizard", label: "Continue setup" }
  }
  if (currentIndex === 2) {
    return { kind: "navigate_repositories", label: "Link GitHub" }
  }
  if (currentIndex === 3) {
    return { kind: "open_wizard", label: "Select repository" }
  }
  return { kind: "open_scope", label: "Configure scope" }
}

/** Whether the org has started or has an Atlassian connector worth showing in the list. */
export function hasConfluenceConnectionRow(
  status: AtlassianConnectorStatus | undefined,
): boolean {
  if (!status) return false
  return Boolean(
    status.isLinked || status.isInstalled || status.installationStatus != null,
  )
}
