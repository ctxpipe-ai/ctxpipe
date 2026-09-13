import { IconChevronDown } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import {
  StartWorkspaceConversationError,
  workspaceDetailOptions,
} from "@/features/workspaces/queries"
import {
  newUiConversationId,
  openWorkspaceConversation,
} from "@/features/workspaces/start-workspace-conversation-ui"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

export function HomeComposer(props: {
  orgSlug: string
  workspaces: Workspace[]
  selected: Workspace | null
  onSelectWorkspace: (workspaceId: string) => void
}) {
  const { orgSlug, workspaces, selected, onSelectWorkspace } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const selectNav = useSelectNav()
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const pendingConversationRef = useRef<{
    workspaceId: string
    conversationId: string
    idempotencyKey: string
  } | null>(null)

  const prefetchWorkspace = (workspace: Workspace) => {
    void queryClient.prefetchQuery(
      workspaceDetailOptions(orgSlug, workspace.slug),
    )
  }
  if (selected) prefetchWorkspace(selected)

  const startConversation = async (text: string) => {
    if (!selected) return
    const pending =
      pendingConversationRef.current?.workspaceId === selected.id
        ? pendingConversationRef.current
        : null
    const conversationId = pending?.conversationId ?? newUiConversationId()
    const idempotencyKey = pending?.idempotencyKey ?? conversationId
    pendingConversationRef.current = {
      workspaceId: selected.id,
      conversationId,
      idempotencyKey,
    }
    setSendError(null)
    setSending(true)
    try {
      await openWorkspaceConversation({
        queryClient,
        navigate,
        selectNav,
        orgSlug,
        workspace: selected,
        text,
        conversationId,
        idempotencyKey,
      })
      pendingConversationRef.current = null
    } catch (error) {
      const assigned =
        error instanceof StartWorkspaceConversationError
          ? (error.conversationId ?? conversationId)
          : conversationId
      pendingConversationRef.current = {
        workspaceId: selected.id,
        conversationId: assigned,
        idempotencyKey,
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
