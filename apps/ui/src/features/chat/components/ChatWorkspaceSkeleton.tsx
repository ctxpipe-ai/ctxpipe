import { Card, CardContent } from "@/components/ui/Card"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { Link } from "@tanstack/react-router"

export function ChatWorkspaceSkeleton(props: { orgSlug: string }) {
  const { orgSlug } = props
  return (
    <main className="flex h-screen max-h-screen flex-col">
      <div className="w-full flex">
        <div className="flex items-center gap-1 p-5 font-mono text-xs uppercase tracking-widest text-zinc-500">
          <Link
            to="/$orgSlug/chat"
            params={{ orgSlug }}
            className="no-underline hover:underline text-zinc-500 hover:text-zinc-500"
          >
            Chat
          </Link>
          <span aria-hidden>/</span>
          <ShimmerPlaceholder className="inline-block w-24 h-3" />
        </div>
      </div>
      <section className="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-px mr-5 mb-5 ring-1 ring-zinc-800">
        <Card className="h-full min-h-0 border-zinc-800 bg-zinc-950/70">
          <CardContent className="flex h-full min-h-0 flex-col px-0">
            <div className="flex items-center justify-between border-b border-zinc-800 text-zinc-400 py-1 pl-4 pr-3 h-10">
              <ShimmerPlaceholder className="h-3 w-12" />
              <ShimmerPlaceholder className="h-4 w-4 rounded" />
            </div>
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex flex-col gap-2 pl-1 py-3">
                  <ShimmerPlaceholder className="h-4 w-full max-w-[180px]" />
                  <ShimmerPlaceholder className="h-3 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className="flex min-h-0 flex-1 flex-col gap-0 border-zinc-800 bg-zinc-950/70">
          <div className="flex min-h-0 flex-1 flex-col border-zinc-800 ring-0">
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
              <div className="flex flex-col gap-2 w-full max-w-[70%]">
                <ShimmerPlaceholder className="h-4 w-full" />
                <ShimmerPlaceholder className="h-4 w-[85%]" />
                <ShimmerPlaceholder className="h-4 w-1/2" />
              </div>
            </div>
          </div>
          <div className="bg-zinc-950/70 px-4 py-3">
            <ShimmerPlaceholder className="h-12 w-full rounded-md" />
          </div>
        </Card>
      </section>
    </main>
  )
}
