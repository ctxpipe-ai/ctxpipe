import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useListOrganizations, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/")({ component: IndexRoutePage })

/** Exported for Storybook / tests — same component as the `/` file route. */
export function IndexRoutePage() {
  const { data: session, isPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()

  if (isPending || orgsPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  const firstOrg = organizations?.[0]
  if (firstOrg) {
    return (
      <Navigate to="/$orgSlug" params={{ orgSlug: firstOrg.slug }} replace />
    )
  }

  return <Navigate to="/onboarding" replace />
}
