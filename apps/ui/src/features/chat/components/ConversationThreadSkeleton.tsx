import { Skeleton } from "@/components/ui/Skeleton"

export function ConversationThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-4 py-5">
        <div className="ml-auto flex w-full max-w-md flex-col items-end gap-2">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
        <div className="flex w-full max-w-prose flex-col items-start gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[80%]" />
          <Skeleton className="h-4 w-[60%]" />
        </div>
        <div className="flex w-full max-w-prose flex-col items-start gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-[85%]" />
        </div>
      </div>
    </div>
  )
}
