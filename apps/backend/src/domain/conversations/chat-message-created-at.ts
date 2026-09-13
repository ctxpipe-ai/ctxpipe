/** JSON and JSONB store `createdAt` as an ISO string. TanStack wire needs Date. */
export function reviveChatMessageCreatedAt(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  return undefined
}

export function reviveChatMessages<T extends { createdAt?: unknown }>(
  messages: readonly T[],
): T[] {
  return messages.map((message) => {
    if (message.createdAt == null) return message
    const createdAt = reviveChatMessageCreatedAt(message.createdAt)
    if (createdAt === message.createdAt) return message
    if (createdAt) return { ...message, createdAt }
    const rest = { ...message }
    delete rest.createdAt
    return rest
  })
}
