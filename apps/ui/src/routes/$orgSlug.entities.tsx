import { AppShell } from "@/components/AppShell"
import { EntityBrowser } from "@/features/entities"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { IconInfoCircle } from "@tabler/icons-react"

export const Route = createFileRoute("/$orgSlug/entities")({
  component: EntitiesPage,
})

function EntitiesPage() {
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  return (
    <AppShell>
      <div className="flex min-h-screen flex-col">
        <div className="sticky top-0 z-10 border-b border-white/8 bg-zinc-950/80 px-6 py-2 backdrop-blur">
          <div className="flex items-center justify-end">
            <div className="flex items-center gap-2 text-xs text-amber-300">
              <IconInfoCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Showing stub data — FalkorDB not yet connected
            </div>
          </div>
        </div>
        <EntityBrowser />
      </div>
    </AppShell>
  )
}
