import type { LinearConnectorStatus } from "./queries/linear-connector"

export const LINEAR_SETUP_STEPS = [
  { id: "connect", label: "Connect Linear workspace" },
  { id: "github", label: "Link GitHub account" },
  { id: "target", label: "Select sync repository" },
  { id: "scope", label: "Configure Linear scope" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

export const SELF_HOSTED_LINEAR_SETUP_STEPS = [
  { id: "register", label: "Register Linear OAuth app" },
  ...LINEAR_SETUP_STEPS,
] as const

export type LinearOauthAppMeta = {
  globalLinearOauthConfigured: boolean
  oauthAppSaved: boolean
}

export type LinearSetupStepId =
  | (typeof LINEAR_SETUP_STEPS)[number]["id"]
  | "register"
export type LinearWizardBodyId = LinearSetupStepId | "complete"

export function getLinearSetupSteps(oauthMeta?: LinearOauthAppMeta) {
  if (!oauthMeta || oauthMeta.globalLinearOauthConfigured) {
    return LINEAR_SETUP_STEPS
  }
  return SELF_HOSTED_LINEAR_SETUP_STEPS
}

function hostedStepIndex(id: Exclude<LinearSetupStepId, "register">): number {
  return LINEAR_SETUP_STEPS.findIndex((step) => step.id === id)
}

export function getLinearStatusRefetchInterval(
  status:
    | Pick<LinearConnectorStatus, "pendingConfigPrCreating" | "setupPhase">
    | undefined,
): number | false {
  if (
    status?.pendingConfigPrCreating ||
    status?.setupPhase === "awaiting_merge" ||
    status?.setupPhase === "initial_sync"
  ) {
    return 2000
  }
  return false
}

export function getLinearSetupCurrentIndex(
  status: LinearConnectorStatus,
  oauthMeta?: LinearOauthAppMeta,
): number {
  const steps = getLinearSetupSteps(oauthMeta)
  const registerOffset = steps[0]?.id === "register" ? 1 : 0
  if (registerOffset === 1 && !oauthMeta?.oauthAppSaved) return 0
  if (!status.isInstalled) return hostedStepIndex("connect") + registerOffset
  if (!status.isGithubLinked) return hostedStepIndex("github") + registerOffset
  if (!status.syncTarget) return hostedStepIndex("target") + registerOffset
  // Pre-PR config failure has no git draft — resubmit scopes (no DB draftScopes).
  if (
    status.setupPhase === "config_failed" &&
    !status.pendingConfigPullUrl &&
    !status.pendingConfigPrCreating
  ) {
    return hostedStepIndex("scope") + registerOffset
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
    return hostedStepIndex("merge") + registerOffset
  }
  if (status.setupPhase === "live") return steps.length
  return hostedStepIndex("scope") + registerOffset
}

export function getLinearWizardBodyId(
  status: LinearConnectorStatus,
  oauthMeta?: LinearOauthAppMeta,
): LinearWizardBodyId {
  const steps = getLinearSetupSteps(oauthMeta)
  const index = getLinearSetupCurrentIndex(status, oauthMeta)
  return index >= steps.length ? "complete" : (steps[index]?.id ?? "connect")
}

export type LinearCardPrimaryCta =
  | { kind: "open_wizard"; label: string }
  | { kind: "manage_scope"; label: string }
  | { kind: "navigate_repositories"; label: string }

export function getLinearCardPrimaryCta(
  status: LinearConnectorStatus,
  oauthMeta?: LinearOauthAppMeta,
): LinearCardPrimaryCta {
  const body = getLinearWizardBodyId(status, oauthMeta)
  switch (body) {
    case "register":
      return { kind: "open_wizard", label: "Register OAuth app" }
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
      return { kind: "manage_scope", label: "Manage scope" }
  }
}
