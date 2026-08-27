import type { ConversationGitTreeResponse } from "./types"

const STORAGE_PREFIX = "ctxpipe.conversation-git-tree."

export function conversationGitTreeSnapshotKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

export function readConversationGitTreeSnapshot(
  conversationId: string,
): ConversationGitTreeResponse | undefined {
  const store = sessionStore()
  if (!store) return undefined
  const raw = store.getItem(conversationGitTreeSnapshotKey(conversationId))
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationGitTreeResponse>
    if (
      typeof parsed.sha !== "string" ||
      !Array.isArray(parsed.paths) ||
      typeof parsed.branch !== "string"
    ) {
      return undefined
    }
    return {
      sha: parsed.sha,
      branch: parsed.branch,
      paths: parsed.paths.filter((path): path is string => typeof path === "string"),
    }
  } catch {
    return undefined
  }
}

export function writeConversationGitTreeSnapshot(
  conversationId: string,
  tree: ConversationGitTreeResponse,
): void {
  const store = sessionStore()
  if (!store) return
  try {
    store.setItem(
      conversationGitTreeSnapshotKey(conversationId),
      JSON.stringify({
        sha: tree.sha,
        paths: tree.paths,
        branch: tree.branch,
      }),
    )
  } catch {
    // Private mode / quota — refresh then falls back to the live tree.
  }
}

export function clearConversationGitTreeSnapshot(conversationId: string): void {
  sessionStore()?.removeItem(conversationGitTreeSnapshotKey(conversationId))
}

export function clearAllConversationGitTreeSnapshots(): void {
  const store = sessionStore()
  if (!store) return
  const keys: string[] = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
  }
  for (const key of keys) store.removeItem(key)
}
