import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconMessageCirclePlus,
} from "@tabler/icons-react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Link } from "react-aria-components"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import {
  sideNavIconGutterClassName,
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { focusVisibleClassName } from "@/lib/focus-styles"
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

  const composeHref = router.buildLocation({
    to: "/$orgSlug/ws/$workspaceSlug",
    params: { orgSlug, workspaceSlug: workspace.slug },
  }).href

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
  const workspaceActive = current && !currentConversationId
  const showConversations = open

  const row = (
    <div
      data-active={workspaceActive ? "true" : undefined}
      className={sideNavRowClassName({ active: workspaceActive })}
    >
      <button
        type="button"
        className={[
          "flex min-w-0 flex-1 cursor-pointer items-center rounded-lg text-left",
          focusVisibleClassName,
        ].join(" ")}
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
        <span className={sideNavIconGutterClassName}>
          <span className="relative size-4">
            <IconFolder
              className={[
                "absolute inset-0 size-4 transition-all duration-150 ease-out motion-reduce:transition-none",
                showCaret ? "scale-75 opacity-0" : "scale-100 opacity-100",
              ].join(" ")}
              stroke={1.4}
              aria-hidden
            />
            <span
              className={[
                "absolute inset-0 transition-all duration-150 ease-out motion-reduce:transition-none",
                showCaret ? "scale-100 opacity-100" : "scale-75 opacity-0",
              ].join(" ")}
              aria-hidden
            >
              {open ? (
                <IconChevronDown className="size-4" stroke={1.4} />
              ) : (
                <IconChevronRight className="size-4" stroke={1.4} />
              )}
            </span>
          </span>
        </span>
        <span
          className={[sideNavLabelClassName(navExpanded), "truncate pr-1"].join(
            " ",
          )}
          aria-hidden={!navExpanded}
        >
          {workspace.displayName}
        </span>
      </button>
      <Link
        href={composeHref}
        aria-label={`New conversation in ${workspace.displayName}`}
        aria-hidden={!navExpanded}
        isDisabled={!navExpanded}
        className={[
          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-[opacity,width] duration-200 ease-out motion-reduce:transition-none hover:bg-teal-900/30 hover:text-zinc-50",
          focusVisibleClassName,
          navExpanded
            ? "opacity-100"
            : "pointer-events-none w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        <IconMessageCirclePlus className="size-4" stroke={1.4} aria-hidden />
      </Link>
    </div>
  )

  return (
    <li className="w-full">
      {navExpanded ? (
        row
      ) : (
        <SideNavTooltip label={workspace.displayName} enabled>
          {row}
        </SideNavTooltip>
      )}
      {showConversations ? (
        <WorkspaceConversationList
          orgSlug={orgSlug}
          workspace={workspace}
          navExpanded={navExpanded}
          currentConversationId={currentConversationId}
        />
      ) : null}
    </li>
  )
}
