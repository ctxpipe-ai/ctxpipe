const CLAIM_TTL_MS = 15 * 60 * 1000
const activeTurns = new Map<string, number>()

export type WorkspaceChatTurnClaim = {
  conversationId: string
  release: () => void
}

export function claimWorkspaceChatTurn(
  conversationId: string,
): WorkspaceChatTurnClaim | null {
  const id = conversationId.trim()
  const now = Date.now()
  const expiresAt = activeTurns.get(id)
  if (!id || (expiresAt != null && expiresAt > now)) return null
  activeTurns.set(id, now + CLAIM_TTL_MS)
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
  const expiresAt = activeTurns.get(conversationId.trim())
  return expiresAt != null && expiresAt > Date.now()
}

export function resetWorkspaceChatTurnClaims(): void {
  activeTurns.clear()
}
