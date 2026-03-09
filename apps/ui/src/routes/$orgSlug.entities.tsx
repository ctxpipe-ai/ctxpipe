import { AppShell } from "@/components/AppShell"
import { EntityBrowser } from "@/features/entities"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/entities")({
  component: EntitiesPage,
})

function EntitiesPage() {
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  return (
    <AppShell>
      <EntityBrowser />
    </AppShell>
  )
}
