import { type QueryClient, useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import {
  isGuideRecent,
  isWithinGuideWindow,
  oldestCreatedAt,
} from "@/features/home/setup-guide/guide-state"
import {
  landingWorkspace,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import { fetchSsrOrganizations, fetchSsrSession } from "@/lib/auth-ssr"
import { sessionUser } from "@/lib/session-user"
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
  loader: ({ context }) => warmWorkspaceLists(context.queryClient),
  component: IndexRoutePage,
})

/** Exported for tests: the `/` loader. */
export async function warmWorkspaceLists(queryClient: QueryClient) {
  // This loader only warms the cache. The page reads the session in the
  // browser, so a failed server-render call must not stop the page. A failed
  // list read does not throw: Home shows that error.
  const session = await fetchSsrSession().catch(() => null)
  if (!session?.user.onboardingCompletedAt) return
  const organizations = await fetchSsrOrganizations().catch(() => [])
  await Promise.all(
    organizations.map((org) =>
      queryClient
        .ensureQueryData(workspaceListOptions(org.slug))
        .catch(() => undefined),
    ),
  )
}

/** Exported for Storybook / tests — same component as the `/` file route. */
export function IndexRoutePage() {
  const { data: session, isPending } = useSession()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const [{ selectedOrganizationSlug }] = useUserPreferences()
  const { error, error_description, pendingAccountClaim } = Route.useSearch()

  if (isPending || orgsPending) {
    return (
      <div className="flex min-h-screen items-center bg-zinc-950 px-6 py-16">
        <PageBodySkeleton label="Loading" className="mx-auto" />
      </div>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = sessionUser(session)
  if (!user?.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  const orgList = organizations ?? []
  const selected =
    orgList.find((org) => org.slug === selectedOrganizationSlug) ?? orgList[0]
  if (!selected) {
    return <Navigate to="/onboarding" replace />
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

  // A new user, or a new organization, lands on Home, where the setup guide
  // is (CTX-552). An organization with no Workspace gets Home below.
  if (
    isGuideRecent({
      onboardingCompletedAt: user.onboardingCompletedAt,
      orgCreatedAt: selected.createdAt,
      now: Date.now(),
    })
  ) {
    return (
      <Navigate to="/$orgSlug" params={{ orgSlug: selected.slug }} replace />
    )
  }

  return <WorkspaceLandingRedirect orgSlug={selected.slug} />
}

function WorkspaceLandingRedirect(props: { orgSlug: string }) {
  const { orgSlug } = props
  const { data, isError } = useQuery(workspaceListOptions(orgSlug))
  // Home shows a failed list read. Do not send it to the root error screen.
  if (isError) return <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
  if (!data) return null
  const workspace = landingWorkspace(data)
  // With no Workspace, Home shows the setup guide (CTX-552).
  if (!workspace) {
    return <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
  }
  // An organization whose setup started in the last 14 days also gets Home,
  // so the guide stays after the first Workspace.
  if (isWithinGuideWindow(oldestCreatedAt(data.items), Date.now())) {
    return <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
  }
  return (
    <Navigate
      to="/$orgSlug/ws/$workspaceSlug"
      params={{ orgSlug, workspaceSlug: workspace.slug }}
      replace
    />
  )
}
