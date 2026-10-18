import { IconPlus, IconRefresh } from "@tabler/icons-react"
import {
  QueryErrorResetBoundary,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { SideNavRowSkeleton } from "@/components/SideNav/SideNavRowSkeleton"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import { Button } from "@/components/ui/Button"
import { Skeleton, SkeletonSuspense } from "@/components/ui/Skeleton"
import { OnboardingHint } from "@/features/hints/OnboardingHint"
import { isWorkspaceNavOpen } from "./nav"
import { workspaceListOptions } from "./queries"
import { WorkspaceCreateModal } from "./WorkspaceCreateModal"
import { WorkspaceNavRow } from "./WorkspaceNavRow"
import { WorkspaceQueryErrorBoundary } from "./WorkspaceSurface"

export function WorkspaceNavList(props: {
  orgSlug: string
  expanded: boolean
  currentWorkspaceSlug?: string
  currentConversationId?: string
  onSelectNav: (next: SideNavLocation) => void
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset: resetQueries }) => (
        // The key resets a failed state when the org changes: the layout
        // stays mounted on an org switch.
        <WorkspaceQueryErrorBoundary
          key={props.orgSlug}
          fallback={(_error, resetBoundary) => (
            <NavListError
              expanded={props.expanded}
              onRetry={() => {
                resetQueries()
                resetBoundary()
              }}
            />
          )}
        >
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
        </WorkspaceQueryErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

// A quiet line, not an InlineAlert: an exception to the product-ui "Error:
// InlineAlert + next step" rule, because a nav row is too narrow for a slab.
function NavListError(props: { expanded: boolean; onRetry: () => void }) {
  if (props.expanded) {
    return (
      <li className="mx-1.5 flex items-center justify-between gap-2 pl-2 text-xs text-muted-foreground">
        <p>Could not load Workspaces.</p>
        <Button variant="ghost" onPress={props.onRetry}>
          Retry
        </Button>
      </li>
    )
  }
  return (
    <li className="flex w-full justify-center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Retry loading Workspaces"
        onPress={props.onRetry}
      >
        <IconRefresh
          className="size-4 text-muted-foreground"
          stroke={1.4}
          aria-hidden
        />
      </Button>
    </li>
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
  const pathname = useLocation({ select: (location) => location.pathname })
  // The page where Add Workspace opened. A link out of the wizard, for
  // example to Connectors, changes the page and so closes the wizard.
  const [createOpenOn, setCreateOpenOn] = useState<string | null>(null)
  if (createOpenOn !== null && createOpenOn !== pathname) setCreateOpenOn(null)
  const addRef = useRef<HTMLSpanElement>(null)
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
          <span ref={addRef} className="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add Workspace"
              onPress={() => setCreateOpenOn(pathname)}
            >
              <IconPlus
                className="size-4 text-muted-foreground"
                stroke={1.4}
                aria-hidden
              />
            </Button>
          </span>
          {n > 0 ? (
            <OnboardingHint
              id="add-workspace"
              orgSlug={orgSlug}
              triggerRef={addRef}
              placement="right"
            >
              Add a Workspace for each team or product.
            </OnboardingHint>
          ) : null}
          <WorkspaceCreateModal
            orgSlug={orgSlug}
            isOpen={createOpenOn !== null}
            onOpenChange={(open) => setCreateOpenOn(open ? pathname : null)}
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
