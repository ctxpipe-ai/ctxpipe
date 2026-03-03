import type { UIMessage } from "ai"

export type ConversationListItem = {
  id: string
  name: string
  source: string
  lastMessageAt: string | null
}

export type ConversationDetail = {
  conversation: ConversationListItem & {
    orgId: string
    createdAt: string
    updatedAt: string
  }
  messages: UIMessage[]
}
