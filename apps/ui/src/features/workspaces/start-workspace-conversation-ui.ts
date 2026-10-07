import type { QueryClient } from "@tanstack/react-query"
import type { NavigateFn } from "@tanstack/react-router"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { insertConversationListItem } from "@/features/chat/insertConversationListItem"
import type {
  ConversationDetail,
  ConversationListInfiniteData,
} from "@/features/chat/types"
import {
  workspaceDetailOptions,
  workspaceKeys,
  workspaceListOptions,
} from "./queries"
import type { WorkspaceDetail, WorkspaceListResponse } from "./types"

export function newUiConversationId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `conv_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`
}

export function seedWorkspaceDetailFromList(input: {
  queryClient: QueryClient
  orgSlug: string
  workspace: { id: string; slug: string }
}): WorkspaceDetail | undefined {
  const detailKey = workspaceDetailOptions(
    input.orgSlug,
    input.workspace.slug,
  ).queryKey
  const existing = input.queryClient.getQueryData<WorkspaceDetail>(detailKey)
  if (existing) return existing
  const listed = input.queryClient
    .getQueryData<WorkspaceListResponse>(
      workspaceListOptions(input.orgSlug).queryKey,
    )
    ?.items.find(
      (item) =>
        item.id === input.workspace.id || item.slug === input.workspace.slug,
    )
  if (!listed) return undefined
  const seeded: WorkspaceDetail = {
    ...listed,
    linkedRepositories: [],
  }
  input.queryClient.setQueryData(detailKey, seeded)
  return seeded
}

export function seedWorkspaceConversation(input: {
  queryClient: QueryClient
  orgSlug: string
  workspaceId: string
  conversationId: string
}): ConversationDetail {
  const now = new Date().toISOString()
  const detail: ConversationDetail = {
    conversation: {
      id: input.conversationId,
      name: "New conversation",
      source: "ui",
      lastMessageAt: now,
      orgId: "",
      workspaceId: input.workspaceId,
      createdAt: now,
      updatedAt: now,
    },
    messages: [],
  }
  input.queryClient.setQueryData(
    workspaceKeys.conversation(
      input.orgSlug,
      input.conversationId,
      input.workspaceId,
    ),
    detail,
  )
  input.queryClient.setQueriesData<ConversationListInfiniteData>(
    {
      queryKey: workspaceKeys.conversations(input.orgSlug, input.workspaceId),
    },
    (old) =>
      insertConversationListItem(old, {
        id: input.conversationId,
        name: "New conversation",
        source: "ui",
        lastMessageAt: now,
      }),
  )
  return detail
}

export function openWorkspaceConversation(input: {
  queryClient: QueryClient
  navigate: NavigateFn
  selectNav: (next: SideNavLocation) => void
  orgSlug: string
  workspace: { id: string; slug: string }
  text: string
}): void {
  const conversationId = newUiConversationId()
  seedWorkspaceConversation({
    queryClient: input.queryClient,
    orgSlug: input.orgSlug,
    workspaceId: input.workspace.id,
    conversationId,
  })
  seedWorkspaceDetailFromList({
    queryClient: input.queryClient,
    orgSlug: input.orgSlug,
    workspace: input.workspace,
  })
  // The conversation session takes this message with takeFirstMessage and
  // sends it on its own chat stream. The cache does not survive a reload, so
  // a reload between this navigate and the session mount loses the message.
  // The window is short and the risk is low.
  input.queryClient.setQueryData<string>(
    workspaceKeys.conversationStart(input.orgSlug, conversationId),
    input.text,
  )
  void input.queryClient.prefetchQuery(
    workspaceDetailOptions(input.orgSlug, input.workspace.slug),
  )
  input.selectNav({
    orgSlug: input.orgSlug,
    primary: "workspace",
    workspaceSlug: input.workspace.slug,
    conversationId,
  })
  void input.navigate({
    to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    params: {
      orgSlug: input.orgSlug,
      workspaceSlug: input.workspace.slug,
      conversationId,
    },
    search: (prev) => prev,
  })
}

/**
 * Take the first message that openWorkspaceConversation left for this
 * conversation. It returns the message once, then undefined.
 */
export function takeFirstMessage(
  queryClient: QueryClient,
  orgSlug: string,
  conversationId: string,
): string | undefined {
  const key = workspaceKeys.conversationStart(orgSlug, conversationId)
  const text = queryClient.getQueryData<string>(key)
  queryClient.removeQueries({ queryKey: key, exact: true })
  return text
}
