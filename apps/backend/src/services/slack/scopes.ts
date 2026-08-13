/**
 * Bot token scopes for the Slack connector (intent capture, not channel mirror).
 * `app_mention` events do not require a scope of their own; the bot must still
 * be invited to any channel where capture is requested (ADR-024 §7).
 * `channels:read` / `groups:read` are for `conversations.info` (human-readable
 * channel names in git paths), not for workspace channel catalogues.
 * `chat:write` powers the capturing → captured status reply in-thread.
 * `files:read` exposes file metadata (name/permalink) on thread messages; we
 * do not download binaries into git (ADR-024).
 */
export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "chat:write",
  "files:read",
  "users:read",
  "team:read",
] as const

export function slackBotScopeString(): string {
  return SLACK_BOT_SCOPES.join(",")
}
