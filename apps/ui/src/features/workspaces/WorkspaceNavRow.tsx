import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconMessageCirclePlus,
} from "@tabler/icons-react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { workspaceTitleAction } from "./nav"
import type { Workspace } from "./types"
import { WorkspaceConversationList } from "./WorkspaceConversationList"

export function WorkspaceNavRow(props: {
  orgSlug: string
  workspace: Workspace
  workspaceCount: number
  navExpanded: boolean
  collapsible: boolean
  open: boolean
  current: boolean
  currentConversationId?: string
  onToggle: () => void
  onExpand: () => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const {
    orgSlug,
    workspace,
    workspaceCount,
    navExpanded,
    collapsible,
    open,
    current,
    currentConversationId,
    onToggle,
    onExpand,
  } = props
  const [hovered, setHovered] = useState(false)

  const compose = () => {
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: { orgSlug, workspaceSlug: workspace.slug },
    })
  }

  const resumeMostRecent = () => {
    if (workspace.mostRecentConversationId) {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: workspace.slug,
          conversationId: workspace.mostRecentConversationId,
        },
      })
      return
    }
    compose()
  }

  const onTitleClick = () => {
    const action = workspaceTitleAction({
      workspaceCount,
      isCurrent: current,
    })
    if (action === "compose") {
      compose()
      return
    }
    if (action === "toggle") {
      onToggle()
      return
    }
    resumeMostRecent()
    onExpand()
  }

  const showCaret = collapsible && hovered && navExpanded

  return (
    <li>
      <div
        className={[
          "group relative flex h-10 items-center text-sm font-medium",
          current ? "bg-zinc-900/80 text-zinc-100" : "text-zinc-300",
        ].join(" ")}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-0 text-left"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={onTitleClick}
          aria-expanded={navExpanded ? open : undefined}
          aria-label={
            collapsible
              ? current
                ? `${open ? "Collapse" : "Expand"} ${workspace.displayName}`
                : `Open ${workspace.displayName}`
              : `New conversation in ${workspace.displayName}`
          }
        >
          <span className="flex h-5 w-auto shrink-0 items-center justify-center px-5 text-zinc-400 group-hover:text-zinc-200">
            {showCaret ? (
              open ? (
                <IconChevronDown className="size-4" aria-hidden />
              ) : (
                <IconChevronRight className="size-4" aria-hidden />
              )
            ) : (
              <IconFolder className="size-4" aria-hidden />
            )}
          </span>
          {navExpanded ? (
            <span className="min-w-0 flex-1 truncate pr-1">
              {workspace.displayName}
            </span>
          ) : null}
        </button>
        {navExpanded ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={`New conversation in ${workspace.displayName}`}
            className="mr-2"
            onPress={compose}
          >
            <IconMessageCirclePlus className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {navExpanded && open ? (
        <WorkspaceConversationList
          orgSlug={orgSlug}
          workspace={workspace}
          currentConversationId={currentConversationId}
          onSelect={(conversationId) => {
            void router.navigate({
              to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
              params: {
                orgSlug,
                workspaceSlug: workspace.slug,
                conversationId,
              },
            })
          }}
        />
      ) : null}
    </li>
  )
}
