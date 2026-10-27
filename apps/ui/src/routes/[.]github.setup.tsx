import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { parseError } from "evlog"
import { useEffect, useMemo } from "react"

import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { Spinner } from "@/components/ui/spinner"
import { GithubNotLinkedNotice } from "@/features/connectors/components/GithubNotLinkedNotice"
import { resolveGithubSetupOrganization } from "@/features/connectors/githubConnectFlow"
import { client, userClient } from "@/lib/api"
import { ApiError, readApiJson } from "@/lib/api-result"
import { useListOrganizations } from "@/lib/auth-client"
import {
  consumeGithubSetupOrgHint,
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  GITHUB_SETUP_RESULT_KEY,
  GITHUB_SETUP_RESULT_MESSAGE,
  getActiveGithubPopupFlowState,
} from "@/lib/popup"
import { useGithubSignInEnabled } from "@/lib/useGetAuthConfig"

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
    error: typeof search.error === "string" ? search.error : undefined,
  }),
})

type ConnectGithubViewProps = {
  installationId: number
  selectedOrganizationSlug: string
  connectionId?: string
  /** The error code of a failed GitHub account link. */
  linkError?: string
}

function MissingInstallationIdView() {
  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            GitHub
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
            GitHub
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

export function ConnectGithubView({
  installationId,
  selectedOrganizationSlug,
  connectionId,
  linkError,
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
      await readApiJson(res, {
        message: "Failed to register GitHub installation",
      })
      return orgSlug
    },
    onSuccess: (orgSlug) => {
      try {
        localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
      } catch {
        // ignore
      }
      navigate({
        to: "/$orgSlug/github/setup",
        params: { orgSlug },
      })
    },
  })

  useEffect(() => {
    if (!isIdle) return

    mutate(selectedOrganizationSlug)
  }, [mutate, selectedOrganizationSlug, isIdle])

  const parsedErrorWhy =
    error instanceof ApiError ? error.body.why : parseError(error)?.why
  const githubSignIn = useGithubSignInEnabled()

  if (parsedErrorWhy === "github_not_linked") {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              GitHub
            </span>
          </header>
          <GithubNotLinkedNotice
            githubSignInEnabled={githubSignIn ?? true}
            orgSlug={selectedOrganizationSlug}
            linkError={linkError}
          />
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            GitHub
          </span>
        </header>
        <section>
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            Link GitHub installation
          </h1>
          {error ? (
            <div className="mt-8">
              <InlineAlert
                variant="error"
                title="Could not link the GitHub installation"
                actions={
                  <Button
                    variant="outline"
                    className="rounded-md"
                    onPress={() =>
                      void navigate({
                        to: "/$orgSlug/connectors",
                        params: { orgSlug: selectedOrganizationSlug },
                        search: {
                          error: undefined,
                          error_description: undefined,
                          pendingAccountClaim: undefined,
                          notionConnectionId: undefined,
                        },
                      })
                    }
                  >
                    Open Connectors
                  </Button>
                }
              >
                {error.message}
              </InlineAlert>
            </div>
          ) : (
            <>
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
            </>
          )}
        </section>
      </main>
    </AppShell>
  )
}

function DotGitHubSetupPage() {
  const search = Route.useSearch()
  const popupFlow = useMemo(() => getActiveGithubPopupFlowState(), [])
  const callbackPopupNonce = search.state ?? popupFlow?.nonce

  // Only a real popup. A leftover `state` query is not enough — GitHub also
  // sends `state` on full-page Setup URL returns.
  if (popupFlow || isPopupWindow()) {
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
      const res = await userClient.api.v1.me.github.installations[
        ":installationId"
      ].organization.$get({
        param: { installationId: String(search.installation_id) },
      })
      const json = await readApiJson(res, {
        emptyOn: [404],
        empty: null,
        message: "Failed to look up installation organization",
      })
      return json?.orgSlug ?? null
    },
    enabled: !!search.installation_id,
  })

  if (existingOrgPending || orgsPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              GitHub
            </span>
          </header>
          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              Linking GitHub installation
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              Checking your GitHub App installation…
            </p>
            <div className="mt-8">
              <PageBodySkeleton label="Loading GitHub setup" />
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
        to="/$orgSlug/github/setup"
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
      linkError={search.error}
    />
  )
}
