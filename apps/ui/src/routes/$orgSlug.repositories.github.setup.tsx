import { useQuery, useQueryClient } from "@tanstack/react-query"
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
  type GitHubRepositorySetupData,
  GitHubRepositorySetupForm,
} from "@/features/repositories"
import { client } from "@/lib/api"
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

  const { data: setupData, isPending: setupPending } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to fetch setup data")
      return (await res.json()) as GitHubRepositorySetupData
    },
    enabled: !!session,
  })

  if (sessionPending) return null
  if (!session) {
    return (
      <Navigate to="/.auth/sign-in" search={{ redirectTo: redirect }} replace />
    )
  }

  if (setupPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              {returnTo === "connectors" ? "Connectors" : "Repositories"}
            </span>
          </header>
          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              GitHub repository setup
            </h1>
            <p className="mt-3 text-sm text-zinc-300">Loading setup…</p>
          </section>
        </main>
      </AppShell>
    )
  }

  const goBack = () => {
    if (returnTo === "connectors") {
      navigate({ to: "/$orgSlug/connectors", params: { orgSlug } })
    } else {
      navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
    }
  }

  const onSaveSuccess = () => {
    if (returnTo === "connectors") {
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    }
    goBack()
  }

  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <GitHubRepositorySetupForm
          orgSlug={orgSlug}
          setupData={setupData ?? undefined}
          pageContext={
            returnTo === "connectors" ? "connectors" : "repositories"
          }
          onSaveSuccess={onSaveSuccess}
          onCancel={goBack}
        />
      </main>
    </AppShell>
  )
}
