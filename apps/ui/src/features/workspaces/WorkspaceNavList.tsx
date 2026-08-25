import { useSuspenseQuery } from "@tanstack/react-query"
import { Suspense, useState } from "react"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { SkeletonRow } from "@/components/ui/Skeleton"
import { isWorkspaceNavOpen } from "./nav"
import { workspaceListOptions } from "./queries"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
  onSelectNav: (next: SideNavLocation) => void
}) {
  return (
    <Suspense
      fallback={
        props.expanded ? (
          <>
            <li className="mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center px-2">
              <p className="text-[10px] font-normal uppercase tracking-tighter text-muted-foreground">
                Workspaces
              </p>
            </li>
            <li className="space-y-0.5">
              <div aria-busy>
                <span className="sr-only">Loading workspaces</span>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </div>
            </li>
          </>
        ) : (
          <li>
            <div aria-busy>
              <span className="sr-only">Loading workspaces</span>
              <SkeletonRow className="mx-1.5 w-[calc(100%-0.75rem)] px-0" />
            </div>
          </li>
        )
      }
    >
      <WorkspaceNavListReady {...props} />
    </Suspense>
  )
}

function WorkspaceNavListReady(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
  onSelectNav: (next: SideNavLocation) => void
}) {
  const {
    orgSlug,
    expanded,
    currentWorkspaceSlug,
    currentConversationId,
    onSelectNav,
  } = props
  const { data } = useSuspenseQuery(workspaceListOptions(orgSlug))
  const workspaces = data.items
  const n = workspaces.length
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [syncedSlug, setSyncedSlug] = useState<string | undefined>(undefined)
  const currentWorkspace = workspaces.find(
    (workspace) => workspace.slug === currentWorkspaceSlug,
  )
  if (n > 1 && currentWorkspace && currentWorkspaceSlug !== syncedSlug) {
    setSyncedSlug(currentWorkspaceSlug)
    if (!expandedIds.includes(currentWorkspace.id)) {
      setExpandedIds((ids) =>
        ids.includes(currentWorkspace.id) ? ids : [...ids, currentWorkspace.id],
      )
    }
  }

  return (
    <>
      {expanded ? (
        <li className="mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center px-2">
          <p className="text-[10px] font-normal uppercase tracking-tighter text-muted-foreground">
            Workspaces
          </p>
        </li>
      ) : null}
      {workspaces.map((workspace) => {
        const collapsible = n > 1
        const open = isWorkspaceNavOpen({
          workspaceCount: n,
          userExpanded: expandedIds.includes(workspace.id),
        })
        return (
          <WorkspaceNavRow
            key={workspace.id}
            orgSlug={orgSlug}
            workspace={workspace}
            workspaceCount={n}
            navExpanded={expanded}
            collapsible={collapsible}
            open={open}
            current={workspace.slug === currentWorkspaceSlug}
            currentConversationId={currentConversationId}
            onSelectNav={onSelectNav}
            onToggle={() => {
              setExpandedIds((ids) =>
                ids.includes(workspace.id)
                  ? ids.filter((id) => id !== workspace.id)
                  : [...ids, workspace.id],
              )
            }}
            onExpand={() => {
              setExpandedIds((ids) =>
                ids.includes(workspace.id) ? ids : [...ids, workspace.id],
              )
            }}
          />
        )
      })}
    </>
  )
}
