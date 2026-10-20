import type { SlackConnectorStatus } from "./queries/slack-connector"

type SlackSetupView =
  | "loading"
  | "error"
  | "authorize"
  | "github"
  | "workspaces"

export function getSlackSetupView(input: {
  status: SlackConnectorStatus | undefined
  isPending: boolean
  isError?: boolean
}): SlackSetupView {
  if (input.isPending) return "loading"
  if (input.isError) return "error"
  const status = input.status
  if (!status?.isInstalled) return "authorize"
  if (!status.isGithubLinked) return "github"
  return "workspaces"
}

export function getSlackSetupStepIndex(
  status: SlackConnectorStatus | undefined,
): number {
  if (!status?.isInstalled) return 0
  if (!status.isGithubLinked) return 1
  return 2
}

export function getSlackSetupPhaseLabel(
  status: Pick<SlackConnectorStatus, "setupPhase" | "isInstalled">,
): string {
  // A connection holds auth only (ADR-050). The mention capture repository
  // is optional.
  return status.isInstalled ? "Connected" : "Setup required"
}

export function formatSlackBotMention(
  handle: string | null | undefined,
): string {
  const trimmed = handle?.replace(/^@/, "").trim()
  return trimmed ? `@${trimmed}` : "the ctx| bot"
}
