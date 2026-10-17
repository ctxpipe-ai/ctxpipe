/** Unsent composer text, kept per composer for the browser session. */

const STORAGE_PREFIX = "ctxpipe.chat-draft."

export function chatDraftKey(
  orgSlug: string,
  workspaceId: string,
  conversationId = "compose",
): string {
  return `${STORAGE_PREFIX}${orgSlug}.${workspaceId}.${conversationId}`
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function readChatDraft(key: string): string {
  try {
    return sessionStore()?.getItem(key) ?? ""
  } catch {
    return ""
  }
}

export function writeChatDraft(key: string, text: string): void {
  try {
    const store = sessionStore()
    if (!store) return
    if (text) store.setItem(key, text)
    else store.removeItem(key)
  } catch {
    // Storage can be full or blocked; the draft is a convenience.
  }
}
