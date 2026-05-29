import { createFileRoute, Link, Navigate, Outlet } from "@tanstack/react-router"
import { useListOrganizations, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug")({
  component: OrgScopedLayout,
})

function OrgScopedLayout() {
  const { orgSlug } = Route.useParams()
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()

  if (sessionPending) {
    return (
      <main className="onboarding-fade-in min-h-screen bg-zinc-950 text-zinc-100">
        <div className="flex min-h-screen items-center justify-center px-6 text-center">
          <p className="text-sm text-zinc-400">Loading workspace…</p>
        </div>
      </main>
    )
  }

  if (!session) {
    return <Navigate to="/.auth/sign-in" replace />
  }

  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  if (orgsPending) return <Outlet />

  const orgList = organizations ?? []
  if (orgList.length === 0) {
    return <Navigate to="/onboarding" replace />
  }

  const isMember = orgList.some((org) => org.slug === orgSlug)
  if (!isMember) {
    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-lg px-6 py-16">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Access
          </p>
          <h1 className="mt-3 text-xl font-medium tracking-tight text-foreground">
            You do not have access to this organisation
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The URL may be wrong, or you may have been removed from{" "}
            <span className="font-mono text-foreground">{orgSlug}</span>. Check
            the address or open a workspace you belong to.
          </p>
          <p className="mt-6">
            <Link
              to="/"
              className="text-sm text-teal-400 no-underline hover:text-teal-300 hover:underline"
            >
              Go to home
            </Link>
          </p>
        </div>
      </main>
    )
  }

  return <Outlet />
}
