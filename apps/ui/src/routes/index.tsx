import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { hasCompletedOnboarding } from "@/lib/onboarding"
import { usePreferredOrganization } from "@/lib/orgs"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const { data: session, isPending } = useSession()
  const { targetOrganization, orgsPending } = usePreferredOrganization()

  if (isPending || orgsPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  if (!hasCompletedOnboarding(session.user.id)) {
    return <Navigate to="/onboarding" replace />
  }

  if (targetOrganization) {
    return (
      <Navigate
        to={`/$orgSlug`}
        params={{ orgSlug: targetOrganization.slug }}
        replace
      />
    )
  }

  return <Navigate to="/onboarding" replace />
}
