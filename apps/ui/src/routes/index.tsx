import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import {
  fetchWorkspaces,
  landingWorkspace,
  workspaceKeys,
} from "@/features/workspaces/queries"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

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
  const [{ selectedOrganizationSlug }] = useUserPreferences()
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

  const orgList = organizations ?? []
  const selected =
    orgList.find((org) => org.slug === selectedOrganizationSlug) ?? orgList[0]
  if (!selected) {
    return <Navigate to="/onboarding" search={{ orgSlug: undefined }} replace />
  }

  if (error != null || pendingAccountClaim != null) {
    return (
      <Navigate
        to="/$orgSlug/connectors"
        params={{ orgSlug: selected.slug }}
        search={{
          error,
          error_description,
          pendingAccountClaim,
          notionConnectionId: undefined,
        }}
        replace
      />
    )
  }

  return <WorkspaceLandingRedirect orgSlug={selected.slug} />
}

function WorkspaceLandingRedirect(props: { orgSlug: string }) {
  const { orgSlug } = props
  const query = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  if (query.isPending) return null
  const workspace = query.data ? landingWorkspace(query.data) : null
  if (!workspace) {
    return (
      <Navigate to="/$orgSlug/workspaces/new" params={{ orgSlug }} replace />
    )
  }
  return (
    <Navigate
      to="/$orgSlug/ws/$workspaceSlug"
      params={{ orgSlug, workspaceSlug: workspace.slug }}
      replace
    />
  )
}
