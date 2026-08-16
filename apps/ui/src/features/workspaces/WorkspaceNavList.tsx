import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { isWorkspaceNavOpen } from "./nav"
import { fetchWorkspaces, workspaceKeys } from "./queries"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
}) {
  const { orgSlug, expanded, currentWorkspaceSlug, currentConversationId } =
    props
  const workspacesQuery = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const workspaces = workspacesQuery.data?.items ?? []
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

  if (!expanded && workspacesQuery.isPending) {
    return (
      <li>
        <span className="sr-only">Loading Workspaces</span>
      </li>
    )
  }

  return (
    <>
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
    </>
  )
}
