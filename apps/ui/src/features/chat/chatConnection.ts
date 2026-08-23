export function workspaceChatHttpPath(orgSlug: string, conversationId: string) {
  return `/${orgSlug}/api/v1/conversations/${conversationId}`
}
