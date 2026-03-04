import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"

export function ConversationListSkeleton() {
  return (
    <div className="flex flex-col p-0">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="flex flex-col pl-5 pr-3 py-3 text-left"
          aria-hidden
        >
          <div className="flex flex-col flex-1 min-w-0 gap-2">
            <ShimmerPlaceholder className="h-4 w-full max-w-[180px]" />
            <ShimmerPlaceholder className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}
