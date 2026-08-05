import type { SlackConnectorStatus } from "./queries/slack-connector"

export type SlackSetupView =
  | "loading"
  | "error"
  | "authorize"
  | "github"
  | "configure"
  | "creating_pr"
  | "awaiting_merge"
  | "initial_sync"
  | "complete"

export function getSlackSetupView(input: {
  status: SlackConnectorStatus | undefined
  isPending: boolean
  isError?: boolean
  showCompletion: boolean
}): SlackSetupView {
  if (input.isPending) return "loading"
  if (input.isError) return "error"
  const status = input.status
  if (!status?.isInstalled) return "authorize"
  if (!status.isGithubLinked) return "github"
  if (status.pendingConfigPrCreating) return "creating_pr"
  if (status.setupPhase === "awaiting_merge") return "awaiting_merge"
  if (status.setupPhase === "initial_sync") return "initial_sync"
  if (status.setupPhase === "live" && input.showCompletion) return "complete"
  return "configure"
}

export function getSlackSetupStepIndex(
  status: SlackConnectorStatus | undefined,
): number {
  if (!status?.isInstalled) return 0
  if (!status.isGithubLinked) return 1
  if (status.selectedChannelCount === 0) return 2
  if (!status.syncTargetConfigured) return 3
  if (status.setupPhase === "live") return 5
  return 4
}

export function getSlackSetupPhaseLabel(
  status: Pick<SlackConnectorStatus, "pendingConfigPrCreating" | "setupPhase">,
): string {
  if (status.pendingConfigPrCreating) return "Creating pull request"
  switch (status.setupPhase) {
    case "awaiting_merge":
      return "Awaiting pull request merge"
    case "initial_sync":
      return "Syncing Slack content"
    case "live":
      return "Connected"
    default:
      return "Setup required"
  }
}
