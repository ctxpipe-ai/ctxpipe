import type { LinearConnectorStatus } from "./queries/linear-connector"

export const LINEAR_SETUP_STEPS = [
  { id: "connect", label: "Connect Linear workspace" },
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Configure Linear scope" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export type LinearSetupStepId = (typeof LINEAR_SETUP_STEPS)[number]["id"]
export type LinearWizardBodyId = LinearSetupStepId | "complete"

function stepIndex(id: LinearSetupStepId): number {
  return LINEAR_SETUP_STEPS.findIndex((step) => step.id === id)
}

export function getLinearSetupCurrentIndex(
  status: LinearConnectorStatus,
): number {
  if (!status.isInstalled) return stepIndex("connect")
  if (!status.isGithubLinked) return stepIndex("github")
  if (!status.syncTarget) return stepIndex("target")
  if (status.setupPhase === "config_failed") return stepIndex("merge")
  if (status.selectedScopeCount === 0) return stepIndex("scope")
  if (status.setupPhase === "live") return LINEAR_SETUP_STEPS.length
  return stepIndex("merge")
}

export function getLinearWizardBodyId(
  status: LinearConnectorStatus,
): LinearWizardBodyId {
  const index = getLinearSetupCurrentIndex(status)
  return index >= LINEAR_SETUP_STEPS.length
    ? "complete"
    : (LINEAR_SETUP_STEPS[index]?.id ?? "connect")
}

export type LinearCardPrimaryCta =
  | { kind: "open_wizard"; label: string }
  | { kind: "navigate_repositories"; label: string }

export function getLinearCardPrimaryCta(
  status: LinearConnectorStatus,
): LinearCardPrimaryCta {
  const body = getLinearWizardBodyId(status)
  switch (body) {
    case "connect":
      return { kind: "open_wizard", label: "Connect Linear" }
    case "github":
      return { kind: "navigate_repositories", label: "Link GitHub" }
    case "target":
      return { kind: "open_wizard", label: "Select repository" }
    case "scope":
      return { kind: "open_wizard", label: "Configure scope" }
    case "merge":
      return {
        kind: "open_wizard",
        label:
          status.setupPhase === "sync_failed" ||
          status.setupPhase === "config_failed"
            ? "Review failure"
            : "Continue setup",
      }
    case "complete":
      return { kind: "open_wizard", label: "Manage scope" }
  }
}
