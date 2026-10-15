import type { LinearConnectorStatus } from "./queries/linear-connector"

/**
 * Connect Linear, then choose the Workspaces that sync from it (ADR-050).
 * Each Workspace keeps its teams and projects in `.ctxpipe/sources.yaml`.
 */
export const LINEAR_SETUP_STEPS = [
  { id: "connect", label: "Connect Linear workspace" },
  { id: "workspaces", label: "Choose Workspaces" },
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

export function getLinearSetupSteps(oauthMeta?: LinearOauthAppMeta) {
  if (!oauthMeta || oauthMeta.globalLinearOauthConfigured) {
    return LINEAR_SETUP_STEPS
  }
  return SELF_HOSTED_LINEAR_SETUP_STEPS
}

/** The first step that is not done. An installed connection is on "workspaces". */
export function getLinearWizardBodyId(
  status: Pick<LinearConnectorStatus, "isInstalled">,
  oauthMeta?: LinearOauthAppMeta,
): LinearSetupStepId {
  const selfHosted = getLinearSetupSteps(oauthMeta)[0]?.id === "register"
  if (selfHosted && !oauthMeta?.oauthAppSaved) return "register"
  return status.isInstalled ? "workspaces" : "connect"
}

export function getLinearSetupCurrentIndex(
  status: Pick<LinearConnectorStatus, "isInstalled">,
  oauthMeta?: LinearOauthAppMeta,
): number {
  const body = getLinearWizardBodyId(status, oauthMeta)
  return getLinearSetupSteps(oauthMeta).findIndex((step) => step.id === body)
}

/**
 * The card action before the connection is installed. An installed
 * connection has none: "Used in" adds it to Workspaces.
 */
export function getLinearCardPrimaryCta(
  status: Pick<LinearConnectorStatus, "isInstalled">,
  oauthMeta?: LinearOauthAppMeta,
): { label: string } | null {
  switch (getLinearWizardBodyId(status, oauthMeta)) {
    case "register":
      return { label: "Register OAuth app" }
    case "connect":
      return { label: "Connect Linear" }
    case "workspaces":
      // The setup dialog starts from the current Workspaces and scopes.
      return { label: "Manage" }
  }
}
