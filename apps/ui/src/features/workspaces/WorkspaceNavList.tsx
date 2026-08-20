import { useSuspenseQuery } from "@tanstack/react-query"
import { Suspense, useState } from "react"
import { isWorkspaceNavOpen } from "./nav"
import { workspaceListOptions } from "./queries"
import { WorkspaceCreateModal } from "./WorkspaceCreateModal"
import { WorkspaceNavHeading } from "./WorkspaceNavHeading"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
}) {
  return (
    <Suspense
      fallback={
        props.expanded ? (
          <>
            <li className="mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center px-2">
              <p className="ctx-label-muted">Workspaces</p>
            </li>
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Loading…
            </li>
          </>
        ) : (
          <li>
            <span className="sr-only">Loading Workspaces</span>
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
}) {
  const { orgSlug, expanded, currentWorkspaceSlug, currentConversationId } =
    props
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
      <li>
        <WorkspaceNavHeading
          expanded={expanded}
          onAddWorkspace={() => setCreateOpen(true)}
        />
      </li>
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
      <WorkspaceCreateModal
        orgSlug={orgSlug}
        isOpen={createOpen}
        onOpenChange={setCreateOpen}
      />
    </>
  )
}
