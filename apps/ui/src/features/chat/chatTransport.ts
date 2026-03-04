import { DefaultChatTransport } from "ai"

export function createTransport(input: {
  orgSlug: string
  conversationId: string
}) {
  return new DefaultChatTransport({
    api: `/${input.orgSlug}/api/v1/conversations/${input.conversationId}`,
    credentials: "include",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: messages[messages.length - 1],
        source: "ui",
      },
    }),
  })
}
