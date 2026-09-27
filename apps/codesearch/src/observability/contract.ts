/**
 * Attribution keys copied from inbound W3C baggage onto spans and logs.
 * Codesearch is internal-only: the backend sets this baggage, and nothing
 * else calls the service. The list matches the backend.
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
