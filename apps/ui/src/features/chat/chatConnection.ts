export function workspaceChatHttpPath(orgSlug: string, conversationId: string) {
  return `/api/v1/orgs/${orgSlug}/conversations/${conversationId}/chat`
}
