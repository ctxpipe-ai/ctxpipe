/** Two-letter collapsed label for a conversation name. */
export function conversationShortLabel(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  const first = parts[0][0] ?? ""
  const second = parts[1][0] ?? ""
  return `${first}${second}`.toUpperCase()
}
