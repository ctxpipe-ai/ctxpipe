import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconMessageCirclePlus,
} from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { Link } from "react-aria-components"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import {
  sideNavIconGutterClassName,
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { prefetchWorkspaceRouteData } from "./ensure-route-data"
import { workspaceSearch } from "./pane"
import { workspaceTitleAction } from "./nav"
import { workspaceConversationOptions } from "./queries"
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
  onSelectNav: (next: SideNavLocation) => void
  onToggle: () => void
  onExpand: () => void
}) {
  const router = useRouter()
  const search = useSearch({ strict: false })
  const paneSearch = workspaceSearch(search)
  const queryClient = useQueryClient()
  const {
    orgSlug,
    workspace,
    workspaceCount,
    navExpanded,
    collapsible,
    open,
    current,
    currentConversationId,
    onSelectNav,
    onToggle,
    onExpand,
  } = props
  const [hovered, setHovered] = useState(false)
  const titleAction = workspaceTitleAction({
    workspaceCount,
    isCurrent: current,
  })

  const composeHref = router.buildLocation({
    to: "/$orgSlug/ws/$workspaceSlug",
    params: { orgSlug, workspaceSlug: workspace.slug },
    search: paneSearch,
  }).href
  const resumeHref = workspace.mostRecentConversationId
    ? router.buildLocation({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug,
          workspaceSlug: workspace.slug,
          conversationId: workspace.mostRecentConversationId,
        },
        search: paneSearch,
      }).href
    : composeHref
  const titleHref = titleAction === "resume" ? resumeHref : composeHref

  const prefetchWorkspace = (conversationId?: string) => {
    prefetchWorkspaceRouteData({
      queryClient,
      orgSlug,
      workspaceSlug: workspace.slug,
      conversationId,
      warmLandingPane: true,
    })
    if (conversationId) {
      void queryClient.prefetchQuery(
        workspaceConversationOptions(orgSlug, conversationId, workspace.id),
      )
    }
  }

  const prefetchResume = () => {
    if (!workspace.mostRecentConversationId) return
    prefetchWorkspace(workspace.mostRecentConversationId)
  }

  const selectWorkspaceCompose = () => {
    prefetchWorkspace()
    onSelectNav({
      orgSlug,
      primary: "workspace",
      workspaceSlug: workspace.slug,
    })
  }

  const onTitlePress = () => {
    if (titleAction === "toggle") {
      onToggle()
      return
    }
    if (titleAction === "resume" && workspace.mostRecentConversationId) {
      prefetchResume()
      onSelectNav({
        orgSlug,
        primary: "workspace",
        workspaceSlug: workspace.slug,
        conversationId: workspace.mostRecentConversationId,
      })
      onExpand()
      return
    }
    selectWorkspaceCompose()
  }

  const showCaret = collapsible && hovered && navExpanded
  const workspaceActive = current && !currentConversationId
  const showConversations = open
  const titleControlClassName = [
    "flex min-w-0 flex-1 cursor-pointer items-center rounded-md text-left",
    focusVisibleClassName,
  ].join(" ")
  const titleInner = (
    <>
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
    </>
  )
  const titleAriaLabel = collapsible
    ? current
      ? `${open ? "Collapse" : "Expand"} ${workspace.displayName}`
      : `Open ${workspace.displayName}`
    : `New conversation in ${workspace.displayName}`

  const row = (
    <div
      data-active={workspaceActive ? "true" : undefined}
      className={sideNavRowClassName({ active: workspaceActive })}
    >
      {titleAction === "toggle" ? (
        <button
          type="button"
          className={titleControlClassName}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={onTitlePress}
          aria-expanded={navExpanded ? open : undefined}
          aria-label={titleAriaLabel}
        >
          {titleInner}
        </button>
      ) : (
        <Link
          href={titleHref}
          onPress={onTitlePress}
          onHoverStart={() => {
            setHovered(true)
            if (titleAction === "resume") prefetchResume()
            else prefetchWorkspace()
          }}
          onHoverEnd={() => setHovered(false)}
          className={titleControlClassName}
          aria-expanded={navExpanded ? open : undefined}
          aria-label={titleAriaLabel}
        >
          {titleInner}
        </Link>
      )}
      <Link
        href={composeHref}
        onHoverStart={() => prefetchWorkspace()}
        onPress={selectWorkspaceCompose}
        aria-label={`New conversation in ${workspace.displayName}`}
        aria-hidden={!navExpanded}
        isDisabled={!navExpanded}
        className={[
          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition-[opacity,width] duration-200 ease-out motion-reduce:transition-none hover:bg-teal-900/30 hover:text-zinc-50",
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
          onSelectNav={onSelectNav}
        />
      ) : null}
    </li>
  )
}
