import { useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Navigate,
  useLocation,
  useNavigate,
} from "@tanstack/react-router"
import { useMemo } from "react"
import { AppShell } from "@/components/AppShell"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import {
  GithubWorkspaceDestination,
  GithubWorkspaceDestinationFromApi,
} from "@/features/workspaces/GithubWorkspaceDestination"
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

  if (sessionPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <GithubWorkspaceDestination
            status="loading"
            workspaces={[]}
            onCreateWorkspace={goCreate}
            onSelectWorkspace={() => undefined}
            onClose={goBack}
          />
        </main>
      </AppShell>
    )
  }
  if (!session) {
    return (
      <Navigate to="/.auth/sign-in" search={{ redirectTo: redirect }} replace />
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
