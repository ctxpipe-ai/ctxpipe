import { IconChevronDown } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button as RACButton } from "react-aria-components"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import {
  prepareWorkspaceChat,
  workspaceDetailOptions,
} from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { createObjectId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { navigateWithComposerTransition } from "./navigate-with-composer-transition"
import { setPendingWorkspaceCompose } from "./pending-workspace-compose"

export function HomeComposer(props: {
  orgSlug: string
  workspaces: Workspace[]
  selected: Workspace | null
  onSelectWorkspace: (workspaceId: string) => void
}) {
  const { orgSlug, workspaces, selected, onSelectWorkspace } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const prefetchWorkspace = (workspace: Workspace) => {
    void queryClient.prefetchQuery(
      workspaceDetailOptions(orgSlug, workspace.slug),
    )
  }

  const startConversation = (text: string) => {
    if (!selected) return
    const conversationId = createObjectId("conv")
    setPendingWorkspaceCompose({
      conversationId,
      workspaceId: selected.id,
      workspaceSlug: selected.slug,
      orgSlug,
      text,
    })
    void prepareWorkspaceChat(orgSlug, conversationId, selected.id)
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
          sendMessage={({ text }) => startConversation(text)}
          isDisabled={!selected}
          placeholder="Ask about this Workspace…"
        />
      </div>
    </section>
  )
}
