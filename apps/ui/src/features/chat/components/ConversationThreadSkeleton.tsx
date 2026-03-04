import { CardContent } from "@/components/ui/Card"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"

export function ConversationThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-zinc-800 bg-zinc-950/70 ring-0">
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-0">
        <div className="shrink-0 border-b border-zinc-800 px-4 py-3 h-10" />
        <div className="flex-1 px-6 py-6 max-w-5xl mx-auto space-y-6">
          <div className="flex flex-col gap-2 w-full max-w-[70%]">
            <ShimmerPlaceholder className="h-4 w-full" />
            <ShimmerPlaceholder className="h-4 w-[80%]" />
            <ShimmerPlaceholder className="h-4 w-[60%]" />
          </div>
          <div className="flex flex-col gap-2 w-full max-w-[85%] ml-auto">
            <ShimmerPlaceholder className="h-4 w-full" />
            <ShimmerPlaceholder className="h-4 w-2/3" />
          </div>
        </div>
      </CardContent>
    </div>
  )
}
