type SetupStatus = {
  status: "installed" | "revoked"
  webhookConfigured: boolean
}

/**
 * A connection holds auth only (ADR-050, ADR-054): paste a token, add the
 * webhook for live updates, then add Buildkite to Workspaces.
 */
export const BUILDKITE_SETUP_STEPS = [
  { id: "connect", label: "Connect Buildkite" },
  { id: "webhook", label: "Add the webhook" },
  { id: "workspaces", label: "Add to Workspaces" },
] as const

type BuildkiteSetupStep = (typeof BUILDKITE_SETUP_STEPS)[number]["id"] | "done"

export function getBuildkiteSetupStep(
  status: SetupStatus | undefined,
  progress: {
    workspacesDone: boolean
    /** The admin opened setup to paste the token of the webhook again. */
    replaceWebhook: boolean
  },
): BuildkiteSetupStep {
  if (!status || status.status === "revoked") return "connect"
  if (!status.webhookConfigured || progress.replaceWebhook) return "webhook"
  return progress.workspacesDone ? "done" : "workspaces"
}

/** The card action: finish the setup, or Manage once it is complete. */
export function getBuildkiteCardCtaLabel(status: SetupStatus): string {
  if (status.status === "revoked") return "Reconnect Buildkite"
  // As on the other cards, Manage opens the Workspaces step of the setup.
  return status.webhookConfigured ? "Manage" : "Add the webhook"
}
