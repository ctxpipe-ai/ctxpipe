const activeTurns = new Map<string, true>()

export type WorkspaceChatTurnClaim = {
  conversationId: string
  release: () => void
}

export function claimWorkspaceChatTurn(
  conversationId: string,
): WorkspaceChatTurnClaim | null {
  const id = conversationId.trim()
  if (!id || activeTurns.has(id)) return null
  activeTurns.set(id, true)
  let released = false
  return {
    conversationId: id,
    release() {
      if (released) return
      released = true
      activeTurns.delete(id)
    },
  }
}

export function workspaceChatTurnIsBusy(conversationId: string): boolean {
  return activeTurns.has(conversationId.trim())
}

export function resetWorkspaceChatTurnClaims(): void {
  activeTurns.clear()
}
