type SetupStatus = {
  status: "installed" | "revoked"
  webhookConfigured: boolean
}

/**
 * A connection holds auth only (ADR-050, ADR-056): paste a machine-user API
 * key, then add Plain to Workspaces. ctx| creates the webhook target.
 */
export const PLAIN_SETUP_STEPS = [
  { id: "connect", label: "Connect Plain" },
  { id: "workspaces", label: "Add to Workspaces" },
] as const

type PlainSetupStep = (typeof PLAIN_SETUP_STEPS)[number]["id"] | "done"

export function getPlainSetupStep(
  status: SetupStatus | undefined,
  progress: {
    workspacesDone: boolean
    /** The admin opened setup to paste a key again. */
    reconnect: boolean
  },
): PlainSetupStep {
  if (!status || status.status === "revoked" || progress.reconnect)
    return "connect"
  return progress.workspacesDone ? "done" : "workspaces"
}

/**
 * The card action. A reconnect also creates a missing webhook target, so it
 * is the action for both problems; as on the other cards, Manage opens the
 * Workspaces step once the connection is complete.
 */
export function getPlainCardCtaLabel(status: SetupStatus): string {
  return status.status === "revoked" || !status.webhookConfigured
    ? "Reconnect Plain"
    : "Manage"
}
