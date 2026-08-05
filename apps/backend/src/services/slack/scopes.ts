/** Bot token scopes for the Slack connector (least privilege for channel mirror). */
export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "files:read",
  "users:read",
  "team:read",
] as const

export function slackBotScopeString(): string {
  return SLACK_BOT_SCOPES.join(",")
}
