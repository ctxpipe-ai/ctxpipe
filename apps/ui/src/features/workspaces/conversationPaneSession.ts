import type { FileTabSession } from "./fileTabs"
import { seedFileTabSession } from "./fileTabs"
import { type ParsedPane, parsePane, serializePane, visiblePane } from "./pane"

export type ConversationPaneSnapshot = {
  pane: string | null
  collapsed: boolean
  tabs: string[]
  previewPath: string | null
}

export function conversationPaneSessionKey(
  orgSlug: string,
  workspaceSlug: string,
  conversationId: string,
): string {
  return `ctxpipe:ws-pane:${orgSlug}:${workspaceSlug}:${conversationId}`
}

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    return sessionStorage
  } catch {
    return null
  }
}

function isSnapshot(value: unknown): value is ConversationPaneSnapshot {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    (record.pane === null || typeof record.pane === "string") &&
    typeof record.collapsed === "boolean" &&
    Array.isArray(record.tabs) &&
    record.tabs.every((item) => typeof item === "string") &&
    (record.previewPath === null || typeof record.previewPath === "string")
  )
}

export function readConversationPaneSession(
  orgSlug: string,
  workspaceSlug: string,
  conversationId: string,
): ConversationPaneSnapshot | null {
  const store = sessionStore()
  if (!store) return null
  try {
    const raw = store.getItem(
      conversationPaneSessionKey(orgSlug, workspaceSlug, conversationId),
    )
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeConversationPaneSession(
  orgSlug: string,
  workspaceSlug: string,
  conversationId: string,
  snapshot: ConversationPaneSnapshot,
): void {
  const store = sessionStore()
  if (!store) return
  try {
    store.setItem(
      conversationPaneSessionKey(orgSlug, workspaceSlug, conversationId),
      JSON.stringify(snapshot),
    )
  } catch {
    // Private mode / quota — chrome stays in memory for this visit.
  }
}

export function conversationPaneSnapshot(input: {
  pane: ParsedPane
  collapsed: boolean
  tabs: FileTabSession
}): ConversationPaneSnapshot {
  return {
    pane: serializePane(input.pane),
    collapsed: input.collapsed,
    tabs: input.tabs.tabs,
    previewPath: input.tabs.previewPath,
  }
}

export function resolveConversationChrome(input: {
  paneParam?: string
  conversationId?: string
  stored: ConversationPaneSnapshot | null
}): {
  pane: ParsedPane
  collapsed: boolean
  tabs: FileTabSession
} {
  const urlPane = visiblePane(parsePane(input.paneParam))
  const storedTabs: FileTabSession = input.stored
    ? { tabs: input.stored.tabs, previewPath: input.stored.previewPath }
    : { tabs: [], previewPath: null }

  if (urlPane) {
    return {
      pane: urlPane,
      collapsed: false,
      tabs: seedFileTabSession(
        storedTabs,
        urlPane.kind === "file" ? urlPane.path : null,
      ),
    }
  }

  if (!input.conversationId || !input.stored) {
    return {
      pane: { kind: "files" },
      collapsed: true,
      tabs: { tabs: [], previewPath: null },
    }
  }

  return {
    pane: visiblePane(parsePane(input.stored.pane ?? undefined)) ?? {
      kind: "files",
    },
    collapsed: input.stored.collapsed,
    tabs: storedTabs,
  }
}
