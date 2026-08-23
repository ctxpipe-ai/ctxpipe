export const WORKSPACE_CHAT_WS_PATH =
  /^\/([^/]+)\/api\/v1\/conversations\/([^/]+)(?:\/stream)?$/

export function parseConversationWebSocketUpgradeUrl(
  url: string,
): { orgSlug: string; conversationId: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const match = parsed.pathname.match(WORKSPACE_CHAT_WS_PATH)
  const orgSlug = match?.[1]
  const conversationId = match?.[2]
  if (!orgSlug || !conversationId) {
    return null
  }
  return { orgSlug, conversationId }
}

export function isWorkspaceChatWebSocketRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return false
  }
  return WORKSPACE_CHAT_WS_PATH.test(new URL(request.url).pathname)
}
