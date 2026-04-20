import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"

export function ConversationThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <div className="mx-auto w-full max-w-2xl flex-1 space-y-8 p-6">
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          <ShimmerPlaceholder className="h-3 w-14" />
          <ShimmerPlaceholder className="h-4 w-full" />
          <ShimmerPlaceholder className="h-4 w-[80%]" />
          <ShimmerPlaceholder className="h-4 w-[60%]" />
        </div>
        <div className="ml-auto flex w-full max-w-[85%] flex-col items-end gap-2">
          <ShimmerPlaceholder className="h-3 w-10" />
          <ShimmerPlaceholder className="h-24 w-full rounded-none" />
        </div>
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          <ShimmerPlaceholder className="h-3 w-12" />
          <ShimmerPlaceholder className="h-4 w-full" />
          <ShimmerPlaceholder className="h-4 w-[85%]" />
        </div>
      </div>
    </div>
  )
}
