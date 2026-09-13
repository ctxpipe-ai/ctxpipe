import type { QueryClient } from "@tanstack/react-query"
import type { NavigateFn } from "@tanstack/react-router"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { insertConversationListItem } from "@/features/chat/insertConversationListItem"
import type {
  ConversationDetail,
  ConversationListInfiniteData,
} from "@/features/chat/types"
import {
  fetchConversation,
  StartWorkspaceConversationError,
  startWorkspaceConversation,
  workspaceDetailOptions,
  workspaceKeys,
} from "./queries"

export type ConversationStartState = {
  text: string
  idempotencyKey: string
  workspaceId: string
  status: "starting" | "error"
  error?: string
}

export function newUiConversationId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `conv_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`
}

export function seedWorkspaceConversation(input: {
  queryClient: QueryClient
  orgSlug: string
  workspaceId: string
  conversationId: string
  text: string
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
    messages: [
      {
        id: `user-${input.conversationId}`,
        role: "user",
        parts: [{ type: "text", content: input.text }],
      },
    ],
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

export function setConversationStartState(
  queryClient: QueryClient,
  orgSlug: string,
  conversationId: string,
  state: ConversationStartState | null,
) {
  queryClient.setQueryData(
    workspaceKeys.conversationStart(orgSlug, conversationId),
    state,
  )
}

export async function openWorkspaceConversation(input: {
  queryClient: QueryClient
  navigate: NavigateFn
  selectNav: (next: SideNavLocation) => void
  orgSlug: string
  workspace: { id: string; slug: string }
  text: string
  conversationId?: string
  idempotencyKey?: string
}): Promise<{ conversationId: string }> {
  const conversationId = input.conversationId ?? newUiConversationId()
  const idempotencyKey = input.idempotencyKey ?? conversationId
  seedWorkspaceConversation({
    queryClient: input.queryClient,
    orgSlug: input.orgSlug,
    workspaceId: input.workspace.id,
    conversationId,
    text: input.text,
  })
  setConversationStartState(input.queryClient, input.orgSlug, conversationId, {
    text: input.text,
    idempotencyKey,
    workspaceId: input.workspace.id,
    status: "starting",
  })
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
  try {
    const started = await startWorkspaceConversation(input.orgSlug, {
      conversationId,
      idempotencyKey,
      workspaceId: input.workspace.id,
      text: input.text,
    })
    const fetched = await fetchConversation(
      input.orgSlug,
      started.conversationId,
      input.workspace.id,
    )
    if (fetched) {
      input.queryClient.setQueryData(
        workspaceKeys.conversation(
          input.orgSlug,
          started.conversationId,
          input.workspace.id,
        ),
        fetched,
      )
    }
    setConversationStartState(
      input.queryClient,
      input.orgSlug,
      conversationId,
      null,
    )
    return started
  } catch (error) {
    const assigned =
      error instanceof StartWorkspaceConversationError
        ? error.conversationId
        : conversationId
    setConversationStartState(
      input.queryClient,
      input.orgSlug,
      conversationId,
      {
        text: input.text,
        idempotencyKey,
        workspaceId: input.workspace.id,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start conversation",
      },
    )
    throw new StartWorkspaceConversationError(
      error instanceof Error ? error.message : "Failed to start conversation",
      assigned,
    )
  }
}
