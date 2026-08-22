import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Navigate,
  useLocation,
  useNavigate,
} from "@tanstack/react-router"
import { useMemo } from "react"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonRow } from "@/components/ui/Skeleton"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import { GithubWorkspaceDestinationFromApi } from "@/features/workspaces/GithubWorkspaceDestination"
import { useSession } from "@/lib/auth-client"

function returnToFromSearch(search: unknown): "connectors" | undefined {
  if (search && typeof search === "object" && "returnTo" in search) {
    const r = (search as { returnTo?: unknown }).returnTo
    if (r === "connectors") return "connectors"
  }
  return undefined
}

export const Route = createFileRoute("/$orgSlug/repositories/github/setup")({
  component: GitHubSetupPage,
})

function GitHubSetupPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()
  const location = useLocation()
  const returnTo = useMemo(
    () => returnToFromSearch(location.search),
    [location.search],
  )
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const redirect = `/${orgSlug}/repositories/github/setup${
    returnTo ? `?returnTo=${returnTo}` : ""
  }`

  const goBack = () => {
    if (returnTo === "connectors") {
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    }
    void navigate({
      to: "/$orgSlug/connectors",
      params: { orgSlug },
      search: {
        error: undefined,
        error_description: undefined,
        pendingAccountClaim: undefined,
        notionConnectionId: undefined,
      },
    })
  }

  const goCreate = () => {
    void navigate({
      to: "/$orgSlug/workspaces/new",
      params: { orgSlug },
      search: { after: "settings" },
    })
  }

  const installationQuery = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
    enabled: !!session,
  })
  const installationLinked = installationQuery.data?.installationId != null

  if (sessionPending || (session && installationQuery.isPending)) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="ctx-label text-teal-400">GitHub</span>
          </header>
          <div aria-busy>
            <span className="sr-only">Checking GitHub connection</span>
            <SkeletonRow size="catalog" lines={2} />
            <SkeletonRow size="catalog" lines={2} />
          </div>
          <div className="mt-6">
            <Button variant="quiet" onPress={goBack}>
              Close wizard
            </Button>
          </div>
        </main>
      </AppShell>
    )
  }
  if (!session) {
    return (
      <Navigate to="/.auth/sign-in" search={{ redirectTo: redirect }} replace />
    )
  }

  if (installationQuery.isError) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="ctx-label text-teal-400">GitHub</span>
          </header>
          <InlineAlert
            variant="error"
            title="Could not check GitHub"
            actions={
              <Button
                variant="outline"
                className="rounded-lg"
                onPress={() => void installationQuery.refetch()}
              >
                Retry
              </Button>
            }
          >
            Try again, or close the wizard.
          </InlineAlert>
          <div className="mt-6">
            <Button variant="quiet" onPress={goBack}>
              Close wizard
            </Button>
          </div>
        </main>
      </AppShell>
    )
  }

  if (!installationLinked) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="ctx-label text-teal-400">GitHub</span>
          </header>
          <h1 className="text-xl font-medium tracking-tight text-foreground">
            Finish connecting GitHub
          </h1>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
            The GitHub App is not installed yet. Close this wizard and complete
            the install from Connectors.
          </p>
          <div className="mt-8">
            <Button variant="quiet" onPress={goBack}>
              Close wizard
            </Button>
          </div>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <GithubWorkspaceDestinationFromApi
          orgSlug={orgSlug}
          onCreateWorkspace={goCreate}
          onSelectWorkspace={(workspace) => {
            void navigate({
              to: "/$orgSlug/ws/$workspaceSlug",
              params: { orgSlug, workspaceSlug: workspace.slug },
              search: { pane: "settings" },
            })
          }}
          onClose={goBack}
        />
      </main>
    </AppShell>
  )
}
