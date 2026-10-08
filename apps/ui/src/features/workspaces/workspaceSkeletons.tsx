import { Skeleton, SkeletonLine, SkeletonRow } from "@/components/ui/Skeleton"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { GraphWaitState } from "@/features/knowledge-graph/GraphWaitState"
import { cn } from "@/lib/utils"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"

/** Same view as the explorer's loading state, for the SSR and lazy-chunk fallback. */
export function WorkspaceGraphPaneSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center bg-background"
      aria-busy
    >
      <GraphWaitState
        title="Loading graph"
        detail="Large graphs may take a few seconds to arrive and lay out."
        status="Fetching graph"
      />
    </div>
  )
}

export function WorkspaceFilesPaneSkeleton() {
  return (
    <div
      className="grid h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{ gridTemplateColumns: "minmax(0, 208px) minmax(0,1fr)" }}
      aria-busy
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col border-r border-white/[0.06]">
        <div className="flex h-8 shrink-0 items-center px-1" />
        <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden px-1 pb-2">
          <SkeletonRow className="h-6" />
          <SkeletonRow className="h-6 pl-4" />
          <SkeletonRow className="h-6 pl-4" />
          <SkeletonRow className="h-6" />
          <SkeletonRow className="h-6 pl-4" />
          <SkeletonRow className="h-6 pl-8" />
          <SkeletonRow className="h-6 pl-8" />
          <SkeletonRow className="h-6" />
        </div>
      </div>
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-foreground">Loading your files</p>
        <p className="text-sm text-muted-foreground">
          The file tree arrives first, then the file you open.
        </p>
      </div>
    </div>
  )
}

export function WorkspaceFilePreviewSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 p-4" aria-busy>
      <span className="sr-only">Loading file</span>
      <SkeletonLine className="h-4 w-1/3" />
      <SkeletonLine className="h-4 w-full" />
      <SkeletonLine className="h-4 w-[92%]" />
      <SkeletonLine className="h-4 w-[78%]" />
      <SkeletonLine className="h-4 w-[88%]" />
      <SkeletonLine className="h-4 w-2/3" />
      <Skeleton className="mt-2 h-40 w-full" />
    </div>
  )
}

export function WorkspaceSurfaceSkeleton() {
  return (
    <div className="flex h-svh min-h-0 min-w-0" aria-busy>
      <span className="sr-only">Loading workspace</span>
      <div
        className={cn(
          workspaceChromeOuterClassName,
          workspaceChromeOuterFlushClassName,
          "h-full min-w-0 flex-1 pl-0 pr-3",
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={workspaceChromeTabStripClassName}>
            <div className={workspaceChromeTabClassName}>
              <SkeletonLine className="h-4 w-40" />
            </div>
          </div>
          <div className={cn(workspaceChromeCardClassName, "min-h-0 flex-1")}>
            <ConversationThreadSkeleton />
          </div>
        </div>
      </div>
      <div className="hidden h-full min-h-0 w-md shrink-0 flex-col border-l border-white/10 lg:flex">
        <div className={workspaceChromeTabStripClassName}>
          <Skeleton className="mb-px size-8" />
          <Skeleton className="mb-px size-8" />
          <Skeleton className="mb-px size-8" />
        </div>
        <WorkspaceFilesPaneSkeleton />
      </div>
    </div>
  )
}
