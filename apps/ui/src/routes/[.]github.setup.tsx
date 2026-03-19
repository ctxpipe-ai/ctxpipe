import { AppShell } from "@/components/AppShell"
import { client } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { Spinner } from "@/components/ui/spinner"
import { useUserPreferences } from "@/lib/user-preferences"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
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

type ConnectGithubViewProps = {
  installationId: number
  selectedOrganizationSlug: string
}

function MissingInstallationIdView() {
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

function MissingPreferredOrgView() {
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

function ConnectGithubView({
  installationId,
  selectedOrganizationSlug,
}: ConnectGithubViewProps) {
  const navigate = useNavigate()
  const hasCalledRegisterInstallation = useRef(false)
  const [githubNotLinkedError, setGithubNotLinkedError] = useState<ApiError | null>(null)

  const { mutate } = useMutation({
    mutationFn: async (orgSlug: string) => {
      const res = await client[":orgSlug"].api.v1.github.installation.$post({
        param: { orgSlug },
        json: { installationId },
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
      if (err instanceof ApiError && err.code === "github_not_linked") {
        setGithubNotLinkedError(err)

        return
      }

      setGithubNotLinkedError(null)
      toast.error(err.message)
    },
  })

  useEffect(() => {
    if (hasCalledRegisterInstallation.current) return
    hasCalledRegisterInstallation.current = true
    setGithubNotLinkedError(null)

    mutate(selectedOrganizationSlug)
  }, [mutate, selectedOrganizationSlug])

  if (
    githubNotLinkedError instanceof ApiError &&
    githubNotLinkedError.code === "github_not_linked"
  ) {
    return (
      <AppShell>
        <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
          <h1 className="text-2xl font-semibold text-zinc-50">
            Connect your GitHub account to finish setup
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            To securely link this GitHub App installation, we need to verify
            that you have access to Github App.
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

function DotGitHubSetupPage() {
  const [{ selectedOrganizationSlug }] = useUserPreferences()
  const search = Route.useSearch()

  const { data: existingOrgSlug, isPending: existingOrgPending } = useQuery({
    queryKey: ["github-installation-org-lookup", search.installation_id],
    queryFn: async () => {
      const res = await fetch(
        `/api/v1/me/github/installations/${search.installation_id}/organization`,
        { credentials: "include" },
      )
      if (res.status === 404) return null
      if (!res.ok) {
        throw new Error("Failed to look up installation organization")
      }
      const json = (await res.json()) as { orgSlug: string }
      return json.orgSlug
    },
    enabled: !!search.installation_id,
  })

  if (existingOrgPending) {
    return (
      <AppShell>
        <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
          <h1 className="text-2xl font-semibold text-zinc-50">
            Linking GitHub installation
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Checking your GitHub App installation…
          </p>

          <div className="mt-8 max-w-md">
            <p className="flex items-center gap-2 text-sm text-zinc-300">
              <Spinner className="text-zinc-400" />
              Loading…
            </p>
          </div>
        </main>
      </AppShell>
    )
  }

  if (!search.installation_id) return <MissingInstallationIdView />
  if (!selectedOrganizationSlug) return <MissingPreferredOrgView />

  if (existingOrgSlug) {
    return (
      <Navigate
        to="/$orgSlug/repositories/github/setup"
        params={{ orgSlug: existingOrgSlug }}
        replace
      />
    )
  }

  return (
    <ConnectGithubView
      installationId={search.installation_id}
      selectedOrganizationSlug={selectedOrganizationSlug}
    />
  )
}
