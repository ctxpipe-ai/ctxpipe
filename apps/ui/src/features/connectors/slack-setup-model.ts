import type { SlackConnectorStatus } from "./queries/slack-connector"

export type SlackSetupView =
  | "loading"
  | "error"
  | "authorize"
  | "github"
  | "target"
  | "live"

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
  if (status.setupPhase !== "live") return "target"
  return "live"
}

export function getSlackSetupStepIndex(
  status: SlackConnectorStatus | undefined,
): number {
  if (!status?.isInstalled) return 0
  if (!status.isGithubLinked) return 1
  if (status.setupPhase !== "live") return 2
  return 3
}

export function getSlackSetupPhaseLabel(
  status: Pick<SlackConnectorStatus, "setupPhase" | "isInstalled">,
): string {
  if (!status.isInstalled) return "Setup required"
  return status.setupPhase === "live" ? "Connected" : "Setup required"
}

export function formatSlackBotMention(
  handle: string | null | undefined,
): string {
  const trimmed = handle?.replace(/^@/, "").trim()
  return trimmed ? `@${trimmed}` : "the ctx| bot"
}
