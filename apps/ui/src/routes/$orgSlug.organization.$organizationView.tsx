import { OrganizationView } from "@daveyplate/better-auth-ui"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { organizationViewClassNames } from "@/features/organization/organizationViewTheme"
import { useSession } from "@/lib/auth-client"
import { hasCompletedOnboarding } from "@/lib/onboarding"

export const Route = createFileRoute(
  "/$orgSlug/organization/$organizationView",
)({
  component: OrganizationViewRoute,
})

function OrganizationViewRoute() {
  const { data: session, isPending } = useSession()
  const { organizationView } = Route.useParams()

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  if (!hasCompletedOnboarding(session.user.id)) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <h1 className="mb-6 font-mono text-xs font-normal uppercase tracking-[0.24em] text-teal-400 sm:mb-8">
          organisation settings
        </h1>
        {/* Org members / invites: better-auth-ui `OrganizationView` composes cards such as
            OrganizationMembersCard — https://better-auth-ui.com/components/organization-members-card */}
        <OrganizationView
          pathname={organizationView}
          classNames={organizationViewClassNames}
        />
      </main>
    </AppShell>
  )
}
