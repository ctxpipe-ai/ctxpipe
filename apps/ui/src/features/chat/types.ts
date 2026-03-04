import type { UIMessage } from "ai"

export type PageInfo = {
  hasNextPage: boolean
  hasPreviousPage: boolean
  startCursor: string | null
  endCursor: string | null
}

export type ConversationListItem = {
  id: string
  name: string
  source: string | null
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
