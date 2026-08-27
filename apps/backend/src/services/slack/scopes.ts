/**
 * Bot token scopes for the Slack connector (intent capture, not channel mirror).
 * `app_mentions:read` is required for Slack to deliver `app_mention` events;
 * the bot must also be invited to any channel where capture is requested
 * (ADR-025 §7).
 * `channels:read` / `groups:read` are for `conversations.info` (human-readable
 * channel names in git paths), not for workspace channel catalogues.
 * `chat:write` powers the capturing → captured status reply in-thread.
 * `files:read` exposes file metadata and authenticated download URLs so
 * provider-declared thread attachments can be copied into git (ADR-026).
 */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "chat:write",
  "files:read",
  "users:read",
] as const

export function slackBotScopeString(): string {
  return SLACK_BOT_SCOPES.join(",")
}

export function parseSlackScopes(scopeHeader: string | null | undefined) {
  return [
    ...new Set(
      (scopeHeader ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort()
}

export function missingSlackBotScopes(grantedScopes: Iterable<string>) {
  const granted = new Set(grantedScopes)
  return SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope))
}
