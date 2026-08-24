export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

export type ChatTextPart = {
  type: "text"
  content: string
}

export type ChatMessage = {
  id: string
  role: "system" | "user" | "assistant"
  parts: Array<{
    type: string
    content?: string
    text?: string
    url?: string
    title?: string
    name?: string
    id?: string
    data?: unknown
  }>
  createdAt?: Date
}

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
    userId?: string | null
    workspaceId?: string | null
    createdAt: string
    updatedAt: string
  }
  messages: ChatMessage[]
}

export type ConversationListPage = {
  items: ConversationListItem[]
  pageInfo: {
    hasNextPage: boolean
    endCursor: string | null
    hasPreviousPage?: boolean
    startCursor?: string | null
  }
}

export type ConversationListInfiniteData = {
  pages: ConversationListPage[]
  pageParams: Array<string | undefined>
}
