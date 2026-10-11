import { IconPlus } from "@tabler/icons-react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { useState } from "react"
import { SideNavRowSkeleton } from "@/components/SideNav/SideNavRowSkeleton"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { Button } from "@/components/ui/Button"
import { Skeleton, SkeletonSuspense } from "@/components/ui/Skeleton"
import { isWorkspaceNavOpen } from "./nav"
import { workspaceListOptions } from "./queries"
import { WorkspaceCreateModal } from "./WorkspaceCreateModal"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
  onSelectNav: (next: SideNavLocation) => void
}) {
  return (
    <SkeletonSuspense
      fallback={
        <>
          {props.expanded ? (
            <li className="mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center pl-2">
              <p className="text-[10px] font-normal uppercase tracking-tighter text-muted-foreground">
                Workspaces
              </p>
            </li>
          ) : null}
          <li className="w-full">
            <ul className="space-y-0.5" aria-busy>
              <li className="sr-only">Loading workspaces</li>
              {(props.expanded ? [0, 1, 2] : [0]).map((row) => (
                <li key={row} className="w-full">
                  <SideNavRowSkeleton
                    navExpanded={props.expanded}
                    gutter={<Skeleton className="size-4" />}
                  />
                </li>
              ))}
            </ul>
          </li>
        </>
      }
    >
      <WorkspaceNavListReady {...props} />
    </SkeletonSuspense>
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
  const [createOpen, setCreateOpen] = useState(false)
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
        <li className="mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center justify-between pl-2">
          <p className="text-[10px] font-normal uppercase tracking-tighter text-muted-foreground">
            Workspaces
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add Workspace"
            onPress={() => setCreateOpen(true)}
          >
            <IconPlus
              className="size-4 text-muted-foreground"
              stroke={1.4}
              aria-hidden
            />
          </Button>
          <WorkspaceCreateModal
            orgSlug={orgSlug}
            isOpen={createOpen}
            onOpenChange={setCreateOpen}
          />
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
