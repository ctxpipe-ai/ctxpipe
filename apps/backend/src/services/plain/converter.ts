export type PlainArticleForMirror = {
  id: string
  title: string
  slug: string
  contentHtml: string
  groupName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type PlainThreadForMirror = {
  id: string
  ref: string
  title: string
  status: string
  priority: number
  customerName: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
  messages: Array<{
    authorName: string | null
    createdAt: string | null
    /** A note: only the support team sees it. */
    internal: boolean
    /** The plain-text form that Plain gives (`llmText`). */
    text: string
  }>
}
