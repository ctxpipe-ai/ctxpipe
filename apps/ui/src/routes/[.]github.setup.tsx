import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { usePreferredOrganization } from "@/lib/orgs"

export const Route = createFileRoute("/.github/setup")({
  component: DotGitHubSetupPage,
  validateSearch: (search: Record<string, unknown>) => {
    console.log("search", search)
    return {
      installation_id:
        typeof search.installation_id === "number"
          ? search.installation_id
          : undefined,
      setup_action:
        typeof search.setup_action === "string"
          ? search.setup_action
          : undefined,
    }
  },
})

function DotGitHubSetupPage() {
  const { data: session, isPending } = useSession()
  const { targetOrganization } = usePreferredOrganization()
  const search = Route.useSearch()

  if (isPending) return null
  if (!session) {
    const redirectTo = `/.github/setup${typeof window !== "undefined" ? window.location.search : ""}`
    return <Navigate to="/.auth/sign-in" search={{ redirectTo }} replace />
  }

  if (!search.installation_id) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
        <p className="text-red-400">
          Missing installation_id. Please complete the GitHub App installation
          from GitHub.
        </p>
      </main>
    )
  }

  if (targetOrganization) {
    return (
      <Navigate
        to="/$orgSlug/github/setup"
        params={{ orgSlug: targetOrganization.slug }}
        search={{ installation_id: search.installation_id }}
        replace
      />
    )
  }

  return null
}
