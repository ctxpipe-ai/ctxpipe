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
): Array<Omit<T, "createdAt"> & { createdAt?: Date }> {
  return messages.map((message) => {
    const createdAt = reviveChatMessageCreatedAt(message.createdAt)
    if (!createdAt) {
      const { createdAt: _drop, ...rest } = message
      return rest
    }
    return { ...message, createdAt }
  })
}
