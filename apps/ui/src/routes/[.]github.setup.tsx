import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { parseError } from "evlog"
import { useEffect, useMemo } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { Spinner } from "@/components/ui/spinner"
import { resolveGithubSetupOrganization } from "@/features/connectors/githubConnectFlow"
import { client } from "@/lib/api"
import { authClient, useListOrganizations } from "@/lib/auth-client"
import {
  consumeGithubSetupOrgHint,
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  GITHUB_SETUP_RESULT_KEY,
  GITHUB_SETUP_RESULT_MESSAGE,
  getActiveGithubPopupFlowState,
} from "@/lib/popup"

export const Route = createFileRoute("/.github/setup")({
  ssr: false,
  component: DotGitHubSetupPage,
  validateSearch: (search: Record<string, unknown>) => ({
    installation_id:
      typeof search.installation_id === "number"
        ? search.installation_id
        : typeof search.installation_id === "string"
          ? Number(search.installation_id) || undefined
          : undefined,
    orgSlug: typeof search.orgSlug === "string" ? search.orgSlug : undefined,
    setup_action:
      typeof search.setup_action === "string" ? search.setup_action : undefined,
    connectionId:
      typeof search.connectionId === "string" ? search.connectionId : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }),
})

type ConnectGithubViewProps = {
  installationId: number
  selectedOrganizationSlug: string
  connectionId?: string
}

function MissingInstallationIdView() {
  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Repositories
          </span>
        </header>
        <section>
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            GitHub setup issue
          </h1>
          <p className="mt-3 text-sm text-red-400">
            Missing installation_id. Please complete the GitHub App installation
            from GitHub.
          </p>
        </section>
      </main>
    </AppShell>
  )
}

function MissingPreferredOrgView() {
  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Repositories
          </span>
        </header>
        <section>
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            Select organization first
          </h1>
          <p className="mt-3 text-sm text-red-400">
            Missing preferred organization. Please select an organization in the
            app (left sidebar) and try again.
          </p>
        </section>
      </main>
    </AppShell>
  )
}

/**
 * `window.opener` is unreliable after cross-origin redirects (Safari/Chrome
 * strip it when navigating github.com → app.ctxpipe.ai). `window.name`
 * survives cross-origin navigations, so we check both.
 */
function isPopupWindow() {
  if (typeof window === "undefined") return false
  return !!window.opener || window.name === GITHUB_POPUP_NAME
}

/**
 * When running inside a popup, we can't make authenticated API calls (the
 * session cookie is often missing after a cross-origin redirect through
 * github.com). Instead, relay the installation_id back to the opener via
 * localStorage and close immediately. The opener reads the value, makes the
 * API call, and cleans up.
 */
function RelayAndClose({
  installationId,
  popupFlowNonce,
}: {
  installationId: number
  popupFlowNonce?: string
}) {
  useEffect(() => {
    let connectionId: string | null = null
    try {
      connectionId = localStorage.getItem(GITHUB_DRAFT_CONNECTION_KEY)
    } catch {
      // localStorage might be unavailable; the opener can still receive the
      // result through postMessage.
    }
    const result = {
      installationId,
      ...(connectionId ? { connectionId } : {}),
      ...(popupFlowNonce ? { popupFlowNonce } : {}),
    }
    try {
      localStorage.setItem(GITHUB_SETUP_RESULT_KEY, JSON.stringify(result))
    } catch {
      // localStorage might be unavailable; the opener will fall back to
      // re-querying without an explicit installation_id.
    }
    try {
      window.opener?.postMessage(
        { type: GITHUB_SETUP_RESULT_MESSAGE, result },
        "*",
      )
    } catch {
      // The opener may be unavailable after a cross-origin redirect.
    }
    window.close()
  }, [installationId, popupFlowNonce])
  return null
}

function CloseOnly() {
  useEffect(() => {
    window.close()
  }, [])
  return null
}

function ConnectGithubView({
  installationId,
  selectedOrganizationSlug,
  connectionId,
}: ConnectGithubViewProps) {
  const navigate = useNavigate()

  const { mutate, error, isIdle } = useMutation({
    scope: { id: `installation-${installationId}` },
    mutationFn: async (orgSlug: string) => {
      const res = await client[":orgSlug"].api.v1.github.installation.$post({
        param: { orgSlug },
        json: {
          installationId,
          ...(connectionId ? { connectionId } : {}),
        },
      })

      if (!res.ok) {
        throw { data: await res.json(), status: res.status }
      }
      return orgSlug
    },
    onSuccess: (orgSlug) => {
      try {
        localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
      } catch {
        // ignore
      }
      navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
    },
    onError: (err) => {
      const parsedError = parseError(err)
      if (parsedError?.why === "github_not_linked") {
        return
      }

      toast.error(err.message)
    },
  })

  useEffect(() => {
    if (!isIdle) return

    mutate(selectedOrganizationSlug)
  }, [mutate, selectedOrganizationSlug, isIdle])

  const parsedError = parseError(error)

  if (parsedError?.why === "github_not_linked") {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              Repositories
            </span>
          </header>
          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              Connect your GitHub account to finish setup
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              To securely link this GitHub App installation, we need to verify
              that you have access to the GitHub App.
            </p>

            <div className="mt-6">
              <Button
                type="button"
                variant="primary"
                className="rounded-none"
                onPress={async () => {
                  await authClient.linkSocial({
                    provider: "github",
                    callbackURL: `/.github/setup${window.location.search ?? ""}`,
                  })
                }}
              >
                Connect GitHub
              </Button>
            </div>
          </section>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Repositories
          </span>
        </header>
        <section>
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            Link GitHub installation
          </h1>
          <p className="mt-3 text-sm text-zinc-400">
            Connecting your GitHub App installation to your preferred
            organization…
          </p>

          <div className="mt-8 max-w-md">
            <p className="flex items-center gap-2 text-sm text-zinc-300">
              <Spinner className="text-zinc-400" />
              Registering installation…
            </p>
          </div>
        </section>
      </main>
    </AppShell>
  )
}

function DotGitHubSetupPage() {
  const search = Route.useSearch()
  const popupFlow = useMemo(() => getActiveGithubPopupFlowState(), [])
  const callbackPopupNonce = search.state ?? popupFlow?.nonce

  // Popup path: relay installation_id via localStorage and close immediately.
  // No API calls — the popup may not have valid auth cookies after the
  // cross-origin redirect through github.com.
  if (popupFlow || isPopupWindow() || search.state) {
    if (search.installation_id) {
      return (
        <RelayAndClose
          installationId={search.installation_id}
          popupFlowNonce={callbackPopupNonce}
        />
      )
    }
    return <CloseOnly />
  }

  // Direct-navigation path: full page with API calls.
  return <DirectSetupPage />
}

function DirectSetupPage() {
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const search = Route.useSearch()
  const hintedOrgSlug = useMemo(() => consumeGithubSetupOrgHint(), [])
  const candidateOrgSlug = search.orgSlug ?? hintedOrgSlug

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

  if (existingOrgPending || orgsPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              Repositories
            </span>
          </header>
          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              Linking GitHub installation
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              Checking your GitHub App installation…
            </p>

            <div className="mt-8 max-w-md">
              <p className="flex items-center gap-2 text-sm text-zinc-300">
                <Spinner className="text-zinc-400" />
                Loading…
              </p>
            </div>
          </section>
        </main>
      </AppShell>
    )
  }

  if (!search.installation_id) return <MissingInstallationIdView />

  const organization = resolveGithubSetupOrganization({
    existingOrgSlug,
    candidateOrgSlug,
    organizationSlugs: organizations?.map((org) => org.slug) ?? [],
  })

  if (organization.kind === "existing") {
    return (
      <Navigate
        to="/$orgSlug/repositories/github/setup"
        params={{ orgSlug: organization.orgSlug }}
        replace
      />
    )
  }

  if (organization.kind === "missing") return <MissingPreferredOrgView />

  return (
    <ConnectGithubView
      installationId={search.installation_id}
      selectedOrganizationSlug={organization.orgSlug}
      connectionId={search.connectionId}
    />
  )
}
