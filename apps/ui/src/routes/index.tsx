import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  return (
    <AppShell>
      <main>please select org</main>
    </AppShell>
  )
}
