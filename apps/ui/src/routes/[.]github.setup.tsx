import { AppShell } from "@/components/AppShell"
import { client } from "@/lib/api"
import { authClient, useSession } from "@/lib/auth-client"
import { Spinner } from "@/components/ui/spinner"
import { useUserPreferences } from "@/lib/user-preferences"
import { useMutation } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { toast } from "sonner"

class ApiError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = "ApiError"
    this.code = code
  }
}

export const Route = createFileRoute("/.github/setup")({
  component: DotGitHubSetupPage,
  validateSearch: (search: Record<string, unknown>) => ({
    installation_id:
      typeof search.installation_id === "number"
        ? search.installation_id
        : undefined,
    setup_action:
      typeof search.setup_action === "string" ? search.setup_action : undefined,
  }),
})

function DotGitHubSetupPage() {
  const { data: session, isPending } = useSession()
  const [{ selectedOrganizationSlug }] = useUserPreferences()
  const search = Route.useSearch()
  const navigate = useNavigate()

  const { mutate, status, error } = useMutation({
    mutationFn: async (orgSlug: string) => {
      if (!search.installation_id) throw new Error("Missing installation_id")
      const res = await client[":orgSlug"].api.v1.github.installation.$post({
        param: { orgSlug },
        json: { installationId: search.installation_id },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string
          code?: string
        }
        throw new ApiError(
          err.error ?? "Failed to register installation",
          err.code,
        )
      }
      return orgSlug
    },
    onSuccess: (orgSlug) => {
      navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === "github_not_linked") return
      toast.error(err.message)
    },
  })

  useEffect(() => {
    if (!session) return
    if (!selectedOrganizationSlug) return
    if (!search.installation_id) return
    if (error instanceof ApiError && error.code === "github_not_linked") return
    if (status !== "idle") return
    mutate(selectedOrganizationSlug)
  }, [
    mutate,
    status,
    selectedOrganizationSlug,
    session,
    search.installation_id,
    error,
  ])

  if (isPending) return null
  if (!session) {
    const redirectTo = `/.github/setup${typeof window !== "undefined" ? window.location.search : ""}`
    return <Navigate to="/.auth/sign-in" search={{ redirectTo }} replace />
  }

  if (!search.installation_id) {
    return (
      <AppShell>
        <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
          <p className="text-red-400">
            Missing installation_id. Please complete the GitHub App installation
            from GitHub.
          </p>
        </main>
      </AppShell>
    )
  }

  if (!selectedOrganizationSlug) {
    return (
      <AppShell>
        <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
          <p className="text-red-400">
            Missing preferred organization. Please select an organization in the
            app (left sidebar) and try again.
          </p>
        </main>
      </AppShell>
    )
  }

  if (error instanceof ApiError && error.code === "github_not_linked") {
    return (
      <AppShell>
        <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
          <h1 className="text-2xl font-semibold text-zinc-50">
            Connect GitHub to finish setup
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            To securely link this GitHub App installation, we need you to connect
            your GitHub account.
          </p>

          <div className="mt-6">
            <button
              type="button"
              className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200"
              onClick={async () => {
                await authClient.linkSocial({
                  provider: "github",
                  callbackURL: `/.github/setup${window.location.search ?? ""}`,
                })
              }}
            >
              Connect GitHub
            </button>
          </div>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold text-zinc-50">
          Link GitHub installation
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Connecting your GitHub App installation to your preferred
          organization…
        </p>

        <div className="mt-8 max-w-md">
          <p className="flex items-center gap-2 text-sm text-zinc-300">
            <Spinner className="text-zinc-400" />
            Registering installation…
          </p>
        </div>
      </main>
    </AppShell>
  )
}
