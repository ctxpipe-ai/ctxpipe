import { IconChevronDown } from "@tabler/icons-react"
import { useChat } from "@tanstack/ai-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
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
  workspaceDetailOptions,
  workspaceKeys,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { workspaceChatWebSocket } from "@/features/workspaces/workspaceChatWebSocket"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { createObjectId } from "@/lib/id"
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

  const prefetchWorkspace = (workspace: Workspace) => {
    void queryClient.prefetchQuery(
      workspaceDetailOptions(orgSlug, workspace.slug),
    )
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
        {selected ? (
          <HomeComposerSession
            key={selected.id}
            orgSlug={orgSlug}
            workspace={selected}
            prefetchWorkspace={prefetchWorkspace}
          />
        ) : (
          <MessageInputBox
            layout="empty"
            sendMessage={() => undefined}
            isDisabled
            placeholder="Ask about this Workspace…"
          />
        )}
      </div>
    </section>
  )
}

function HomeComposerSession(props: {
  orgSlug: string
  workspace: Workspace
  prefetchWorkspace: (workspace: Workspace) => void
}) {
  const { orgSlug, workspace, prefetchWorkspace } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [conversationId] = useState(() => createObjectId("conv"))
  const sendFailedRef = useRef(false)
  const connection = useMemo(
    () => workspaceChatWebSocket(orgSlug, conversationId),
    [orgSlug, conversationId],
  )

  useEffect(() => {
    connection.warm()
    return () => {
      connection.dispose()
    }
  }, [connection])

  const { sendMessage, status, error, isLoading, stop } = useChat({
    threadId: conversationId,
    connection,
    persistence: true,
    forwardedProps: {
      workspaceId: workspace.id,
      source: "ui",
    },
    onError: () => {
      sendFailedRef.current = true
    },
  })

  const handleSendMessage = async (params: { text: string }) => {
    sendFailedRef.current = false
    try {
      await sendMessage(params.text)
    } catch {
      return
    }
    if (sendFailedRef.current) return
    const now = new Date().toISOString()
    const detail: ConversationDetail = {
      conversation: {
        id: conversationId,
        name: "New conversation",
        source: "ui",
        lastMessageAt: now,
        orgId: "",
        workspaceId: workspace.id,
        createdAt: now,
        updatedAt: now,
      },
      messages: [
        {
          id: `user-${conversationId}`,
          role: "user",
          parts: [{ type: "text", content: params.text }],
        },
      ],
    }
    queryClient.setQueryData(
      workspaceKeys.conversation(orgSlug, conversationId, workspace.id),
      detail,
    )
    queryClient.setQueriesData<ConversationListInfiniteData>(
      { queryKey: workspaceKeys.conversations(orgSlug, workspace.id) },
      (old) =>
        insertConversationListItem(old, {
          id: conversationId,
          name: "New conversation",
          source: "ui",
          lastMessageAt: now,
        }),
    )
    prefetchWorkspace(workspace)
    navigateWithComposerTransition(() => {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: workspace.slug,
          conversationId,
        },
      })
    })
  }

  return (
    <>
      <MessageInputBox
        layout="empty"
        sendMessage={handleSendMessage}
        status={status}
        onStop={stop}
        isDisabled={isLoading}
        placeholder="Ask about this Workspace…"
      />
      {error ? (
        <div className="mt-3">
          <InlineAlert variant="error" title="Could not send">
            {error.message || "Chat request failed."} Send again to retry.
          </InlineAlert>
        </div>
      ) : null}
    </>
  )
}
