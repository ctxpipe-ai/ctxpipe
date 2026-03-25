import { Link } from "@tanstack/react-router"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"

export function ChatWorkspaceSkeleton(props: { orgSlug: string }) {
  const { orgSlug } = props
  return (
    <main className="flex h-screen max-h-screen min-h-0 w-full flex-1 flex-col text-foreground sm:pl-3 md:flex-row">
      <div className="flex max-h-[38vh] shrink-0 flex-col border-b border-white/[0.04] md:max-h-none md:h-full md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between p-4">
          <ShimmerPlaceholder className="h-3 w-28" />
          <div className="flex gap-1">
            <ShimmerPlaceholder className="h-7 w-7 rounded-md" />
            <ShimmerPlaceholder className="h-7 w-7 rounded-md" />
          </div>
        </div>
        <div className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-none p-2.5">
              <ShimmerPlaceholder className="h-4 w-full max-w-[180px]" />
              <ShimmerPlaceholder className="mt-0.5 h-3 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.04] px-6 py-4">
          <Link
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            className="text-sm text-muted-foreground no-underline"
          >
            chat
          </Link>
          <ShimmerPlaceholder className="h-3.5 w-3.5 rounded" />
          <ShimmerPlaceholder className="h-4 w-32" />
        </div>
        <div className="mx-auto max-w-2xl flex-1 space-y-8 p-6">
          <div className="flex w-full max-w-[70%] flex-col gap-2">
            <ShimmerPlaceholder className="h-3 w-16" />
            <ShimmerPlaceholder className="h-4 w-full" />
            <ShimmerPlaceholder className="h-4 w-[80%]" />
          </div>
          <div className="ml-auto flex w-full max-w-[85%] flex-col items-end gap-2">
            <ShimmerPlaceholder className="h-3 w-12" />
            <ShimmerPlaceholder className="h-20 w-full rounded-none" />
          </div>
        </div>
        <div className="shrink-0 border-t border-white/[0.04] p-4">
          <div className="mx-auto max-w-2xl">
            <ShimmerPlaceholder className="h-24 w-full rounded-none" />
          </div>
        </div>
      </div>
    </main>
  )
}
