import { Skeleton, SkeletonLine, SkeletonRow } from "@/components/ui/Skeleton"
import { ConversationThreadSkeleton } from "@/features/chat/components/ConversationThreadSkeleton"
import { cn } from "@/lib/utils"
import {
  workspaceChromeCardClassName,
  workspaceChromeOuterClassName,
  workspaceChromeOuterFlushClassName,
  workspaceChromeTabClassName,
  workspaceChromeTabStripClassName,
} from "./workspaceChrome"

export function WorkspaceFilesPaneSkeleton() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-busy>
      <span className="sr-only">Loading files</span>
      <div className="flex h-8 shrink-0 items-center px-1" />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden px-1 pb-2">
        <SkeletonRow />
        <SkeletonRow className="pl-4" />
        <SkeletonRow className="pl-4" />
        <SkeletonRow />
        <SkeletonRow className="pl-4" />
        <SkeletonRow className="pl-8" />
        <SkeletonRow className="pl-8" />
        <SkeletonRow />
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
