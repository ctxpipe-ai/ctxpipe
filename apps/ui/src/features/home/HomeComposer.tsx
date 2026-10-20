import { IconChevronDown } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button as RACButton } from "react-aria-components"
import { useSelectNav } from "@/components/ShellLayoutContext"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { chatDraftKey } from "@/features/chat/chat-draft"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import { workspaceDetailOptions } from "@/features/workspaces/queries"
import { openWorkspaceConversation } from "@/features/workspaces/start-workspace-conversation-ui"
import type { Workspace } from "@/features/workspaces/types"
import { workspaceSuggestions } from "@/features/workspaces/workspace-suggestions"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { ShowNoticesButton } from "./HomeNotices"

export function HomeComposer(props: {
  orgSlug: string
  workspaces: Workspace[]
  selected: Workspace | null
  onSelectWorkspace: (workspaceId: string) => void
  /** A new value mounts a new text box: it reads the stored draft and takes focus. */
  inputKey?: number
}) {
  const { orgSlug, workspaces, selected, onSelectWorkspace } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const selectNav = useSelectNav()
  const prefetchWorkspace = (workspace: Workspace) => {
    void queryClient.prefetchQuery(
      workspaceDetailOptions(orgSlug, workspace.slug),
    )
  }
  if (selected) prefetchWorkspace(selected)

  const startConversation = (text: string) => {
    if (!selected) return
    openWorkspaceConversation({
      queryClient,
      navigate,
      selectNav,
      orgSlug,
      workspace: selected,
      text,
    })
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
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
        <ShowNoticesButton orgSlug={orgSlug} workspaces={workspaces} />
      </div>
      <div className="mt-3">
        <MessageInputBox
          key={props.inputKey}
          layout="empty"
          sendMessage={({ text }) => startConversation(text)}
          isDisabled={!selected}
          placeholder="What should ctxpipe do in this Workspace?"
          suggestions={workspaceSuggestions}
          draftKey={selected ? chatDraftKey(orgSlug, selected.id) : undefined}
        />
      </div>
    </section>
  )
}
