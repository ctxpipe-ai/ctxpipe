import { AppShell } from "@/components/AppShell"
import { Outlet, Navigate, createFileRoute } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/chat")({
  component: ChatRoute,
})

function ChatRoute() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <AppShell>
        <main className="flex min-h-screen items-center justify-center px-6 text-center text-zinc-100">
          <p className="text-sm text-zinc-400">Loading chat…</p>
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as { id: string; onboardingCompletedAt?: string | null }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
