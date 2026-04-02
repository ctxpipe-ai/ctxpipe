import { AppShell } from "@/components/AppShell"
import { Outlet, Navigate, createFileRoute } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { hasCompletedOnboarding } from "@/lib/onboarding"

export const Route = createFileRoute("/$orgSlug/chat")({
  component: ChatRoute,
})

function ChatRoute() {
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  if (!hasCompletedOnboarding(session.user.id)) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
