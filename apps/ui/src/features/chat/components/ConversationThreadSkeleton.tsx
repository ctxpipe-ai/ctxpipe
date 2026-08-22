import { Skeleton } from "@/components/ui/Skeleton"

export function ConversationThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-8 p-6">
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[80%]" />
          <Skeleton className="h-4 w-[60%]" />
        </div>
        <div className="ml-auto flex w-full max-w-[85%] flex-col items-end gap-2">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-24 w-full rounded-none" />
        </div>
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[85%]" />
        </div>
      </div>
    </div>
  )
}
