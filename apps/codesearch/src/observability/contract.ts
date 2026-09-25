/**
 * Attribution keys and log PII stripping for codesearch.
 * The list matches `ATTRIBUTION_KEYS` in the backend. Codesearch still
 * reads these from inbound baggage because only the backend calls it.
 */

export const ATTRIBUTION_KEYS = [
  "request.id",
  "enduser.id",
  "ctxpipe.org.id",
  "ctxpipe.org.slug",
  "ctxpipe.actor.type",
  "ctxpipe.api_key.id",
  "ctxpipe.oauth.client_id",
  "ctxpipe.mcp.tool",
  "ctxpipe.conversation.id",
  "ctxpipe.repository.id",
  "ctxpipe.connection.id",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stripLogPii(event: Record<string, unknown>): void {
  if (isRecord(event.user)) {
    delete event.user.email
    delete event.user.name
    delete event.user.image
  }
  if (isRecord(event.session)) {
    delete event.session.ipAddress
    delete event.session.userAgent
  }
  delete event.userAgent
  delete event.email
  delete event.ipAddress
  if (isRecord(event.headers)) {
    delete event.headers["user-agent"]
    delete event.headers["User-Agent"]
  }
}
