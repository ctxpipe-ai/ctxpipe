import { useSyncExternalStore } from "react"

export type PendingWorkspaceCompose = {
  conversationId: string
  workspaceId: string
  workspaceSlug: string
  orgSlug: string
  text: string
}

let pending: PendingWorkspaceCompose | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getPendingWorkspaceCompose() {
  return pending
}

export function setPendingWorkspaceCompose(
  next: PendingWorkspaceCompose | null,
) {
  pending = next
  emit()
}

export function usePendingWorkspaceCompose() {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange)
      return () => {
        listeners.delete(onStoreChange)
      }
    },
    () => pending,
    () => null,
  )
}

const sentHomeDrafts = new Set<string>()

export function takeHomeDraftSend(conversationId: string): boolean {
  if (sentHomeDrafts.has(conversationId)) return false
  sentHomeDrafts.add(conversationId)
  return true
}

export function resetHomeDraftSends() {
  sentHomeDrafts.clear()
}
