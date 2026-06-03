import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useListOrganizations, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string"
        ? search.error_description
        : undefined,
    pendingAccountClaim:
      typeof search.pendingAccountClaim === "string"
        ? search.pendingAccountClaim
        : undefined,
  }),
  component: IndexRoutePage,
})

/** Exported for Storybook / tests — same component as the `/` file route. */
export function IndexRoutePage() {
  const { data: session, isPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const { error, error_description, pendingAccountClaim } = Route.useSearch()

  if (isPending || orgsPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" search={{ orgSlug: undefined }} replace />
  }

  const firstOrg = organizations?.[0]
  if (firstOrg) {
    const forward =
      error != null || pendingAccountClaim != null
        ? ("/$orgSlug/connectors" as const)
        : ("/$orgSlug/dashboard" as const)
    return (
      <Navigate
        to={forward}
        params={{ orgSlug: firstOrg.slug }}
        search={{
          error,
          error_description,
          pendingAccountClaim,
        }}
        replace
      />
    )
  }

  return <Navigate to="/onboarding" search={{ orgSlug: undefined }} replace />
}
