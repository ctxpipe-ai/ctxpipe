import { IconChevronDown } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { insertConversationListItem } from "@/features/chat/insertConversationListItem"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import type {
  ConversationDetail,
  ConversationListInfiniteData,
} from "@/features/chat/types"
import {
  StartWorkspaceConversationError,
  startWorkspaceConversation,
  workspaceDetailOptions,
  workspaceKeys,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { navigateWithComposerTransition } from "./navigate-with-composer-transition"

export function HomeComposer(props: {
  orgSlug: string
  workspaces: Workspace[]
  selected: Workspace | null
  onSelectWorkspace: (workspaceId: string) => void
}) {
  const { orgSlug, workspaces, selected, onSelectWorkspace } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const pendingConversationRef = useRef<{
    workspaceId: string
    conversationId: string
  } | null>(null)

  const prefetchWorkspace = (workspace: Workspace) => {
    void queryClient.prefetchQuery(
      workspaceDetailOptions(orgSlug, workspace.slug),
    )
  }

  const commitStartedConversation = (conversationId: string, text: string) => {
    if (!selected) return
    const now = new Date().toISOString()
    const detail: ConversationDetail = {
      conversation: {
        id: conversationId,
        name: "New conversation",
        source: "ui",
        lastMessageAt: now,
        orgId: "",
        workspaceId: selected.id,
        createdAt: now,
        updatedAt: now,
      },
      messages: [
        {
          id: `user-${conversationId}`,
          role: "user",
          parts: [{ type: "text", content: text }],
        },
      ],
    }
    queryClient.setQueryData(
      workspaceKeys.conversation(orgSlug, conversationId, selected.id),
      detail,
    )
    queryClient.setQueriesData<ConversationListInfiniteData>(
      { queryKey: workspaceKeys.conversations(orgSlug, selected.id) },
      (old) =>
        insertConversationListItem(old, {
          id: conversationId,
          name: "New conversation",
          source: "ui",
          lastMessageAt: now,
        }),
    )
    prefetchWorkspace(selected)
    navigateWithComposerTransition(() => {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: selected.slug,
          conversationId,
        },
      })
    })
  }

  const startConversation = async (text: string) => {
    if (!selected) return
    const pendingId =
      pendingConversationRef.current?.workspaceId === selected.id
        ? pendingConversationRef.current.conversationId
        : undefined
    setSendError(null)
    setSending(true)
    try {
      const started = await startWorkspaceConversation(orgSlug, {
        conversationId: pendingId,
        workspaceId: selected.id,
        text,
      })
      pendingConversationRef.current = null
      commitStartedConversation(started.conversationId, text)
    } catch (error) {
      const assigned =
        error instanceof StartWorkspaceConversationError
          ? error.conversationId
          : pendingId
      if (assigned) {
        pendingConversationRef.current = {
          workspaceId: selected.id,
          conversationId: assigned,
        }
      }
      setSending(false)
      setSendError(
        error instanceof Error ? error.message : "Failed to start conversation",
      )
    }
  }

  return (
    <section>
      <MenuTrigger
        placement="bottom start"
        popoverClassName="overflow-hidden rounded-md border-zinc-800 bg-zinc-900"
      >
        <RACButton
          className={cn(
            "inline-flex items-center gap-1 rounded-md bg-transparent px-0 py-1 text-sm text-muted-foreground",
            "hover:text-foreground",
            focusVisibleClassName,
          )}
          aria-label="Select workspace"
        >
          {selected?.displayName ?? "Workspace"}
          <IconChevronDown aria-hidden className="size-4" />
        </RACButton>
        <Menu aria-label="Workspaces" className="rounded-md">
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              id={workspace.id}
              textValue={workspace.displayName}
              className="rounded-md"
              onHoverStart={() => prefetchWorkspace(workspace)}
              onAction={() => onSelectWorkspace(workspace.id)}
            >
              {workspace.displayName}
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <div className="mt-3">
        <MessageInputBox
          layout="empty"
          sendMessage={({ text }) => void startConversation(text)}
          isDisabled={!selected || sending}
          placeholder="Ask about this Workspace…"
        />
        {sendError ? (
          <div className="mt-3">
            <InlineAlert variant="error" title="Could not send">
              {sendError} Send again to retry.
            </InlineAlert>
          </div>
        ) : null}
      </div>
    </section>
  )
}
