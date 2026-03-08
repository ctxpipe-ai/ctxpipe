import { AppShell } from "@/components/AppShell"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { Suspense, lazy } from "react"
import { IconInfoCircle } from "@tabler/icons-react"

const GraphVisualization = lazy(() =>
  import("@/features/graph/GraphVisualization").then((m) => ({
    default: m.GraphVisualization,
  })),
)

export const Route = createFileRoute("/$orgSlug/graph")({
  component: GraphPage,
})

function GraphPage() {
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  return (
    <AppShell>
      <div className="flex h-screen flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-white/8 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">
              Knowledge Graph
            </h1>
            <p className="mt-0.5 text-sm text-zinc-400">
              Entity relationship map for this organisation's indexed repositories
            </p>
          </div>
          <StubBanner />
        </header>

        <div className="relative min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-zinc-400">Initialising graph…</p>
              </div>
            }
          >
            <GraphVisualization />
          </Suspense>
        </div>
      </div>
    </AppShell>
  )
}

function StubBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
      <IconInfoCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      Showing stub data — FalkorDB not yet connected
    </div>
  )
}
