import { IconPlus } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  AddConfluenceConnectorButton,
  AddConnectorCatalogDialog,
  AddGithubConnectorButton,
  ConfluenceConnectionCard,
  ConnectorSetupDialog,
  ConnectorsEmptyState,
  EditScopeModal,
  GithubConnectionCard,
} from "@/features/connectors"
import {
  fetchOrgConnections,
  orgConnectionsKeys,
} from "@/features/connectors/queries/org-connections"
import { oauthErrorMessage } from "@/lib/atlassian-oauth-messages"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/connectors")({
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
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()

  if (sessionPending) {
    return (
      <AppShell>
        <main className="mx-auto flex max-w-5xl items-center justify-center px-2 py-16 sm:px-6">
          <Spinner className="text-zinc-400" />
        </main>
      </AppShell>
    )
  }

  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return <ConnectorsPageContent orgSlug={orgSlug} />
}

export function ConnectorsPageContent({ orgSlug }: { orgSlug: string }) {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const queryClient = useQueryClient()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [claimOpen, setClaimOpen] = useState(false)
  const [errorBanner, setErrorBanner] = useState<{
    title: string
    description: string
  } | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardAtlassianConnectionId, setWizardAtlassianConnectionId] =
    useState<string | undefined>(undefined)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scopeConnectionId, setScopeConnectionId] = useState<string | null>(
    null,
  )

  const { data: connections, isPending: connectionsPending } = useQuery({
    queryKey: orgConnectionsKeys.list(orgSlug),
    queryFn: () => fetchOrgConnections(orgSlug),
    enabled: true,
  })

  const items = connections ?? []
  const showPageLoading = connectionsPending && !connections
  const showEmptyState = !showPageLoading && items.length === 0

  useEffect(() => {
    if (search.pendingAccountClaim) {
      setClaimOpen(true)
    }
  }, [search.pendingAccountClaim])

  useEffect(() => {
    if (search.error == null) return
    setErrorBanner(oauthErrorMessage(search.error, search.error_description))
    void navigate({
      to: "/$orgSlug/connectors",
      params: { orgSlug },
      search: (prev) => ({
        orgSlug: prev.orgSlug,
        installation_id: prev.installation_id,
        setup_action: prev.setup_action,
        seed: prev.seed,
        error: undefined,
        error_description: undefined,
        pendingAccountClaim: prev.pendingAccountClaim,
      }),
      replace: true,
    })
  }, [search.error, search.error_description, navigate, orgSlug])

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        {errorBanner ? (
          <div className="mb-6 rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-100">
            <p className="font-medium">{errorBanner.title}</p>
            <p className="mt-1 text-zinc-300">{errorBanner.description}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-semibold text-zinc-50">Connectors</h1>
            <p className="text-sm text-zinc-400">
              Connect external tools and choose what content ctxpipe should
              ingest.
            </p>
          </div>
          {!showEmptyState ? (
            <Button
              variant="secondary"
              size="icon"
              aria-label="Add connection"
              onPress={() => setCatalogOpen(true)}
            >
              <IconPlus className="size-5" aria-hidden />
            </Button>
          ) : null}
        </div>

        <section className="mt-8 grid min-h-0 grid-cols-1 items-stretch gap-8 *:min-h-0 lg:grid-cols-2">
          {showPageLoading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-400 lg:col-span-2">
              <Spinner className="size-4" />
              Loading connections…
            </div>
          ) : showEmptyState ? (
            <div className="lg:col-span-2">
              <ConnectorsEmptyState
                onAddConnection={() => setCatalogOpen(true)}
              />
            </div>
          ) : (
            items.map((row) =>
              row.type === "forge" ? (
                <ConfluenceConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                  onOpenWizard={() => {
                    setWizardAtlassianConnectionId(row.id)
                    setWizardOpen(true)
                  }}
                  onOpenScope={() => {
                    setScopeConnectionId(row.id)
                    setScopeOpen(true)
                  }}
                />
              ) : (
                <GithubConnectionCard
                  key={row.id}
                  orgSlug={orgSlug}
                  connectionId={row.id}
                />
              ),
            )
          )}
        </section>

        <AddConnectorCatalogDialog
          isOpen={catalogOpen}
          onOpenChange={setCatalogOpen}
        >
          <li>
            <AddGithubConnectorButton
              orgSlug={orgSlug}
              onFlowStarted={() => setCatalogOpen(false)}
            />
          </li>
          <li>
            <AddConfluenceConnectorButton
              orgSlug={orgSlug}
              onInstallIntentRegistered={({ connectionId }) => {
                setWizardAtlassianConnectionId(connectionId)
                setWizardOpen(true)
                setCatalogOpen(false)
              }}
            />
          </li>
        </AddConnectorCatalogDialog>

        <ConnectorSetupDialog
          orgSlug={orgSlug}
          atlassianConnectionId={wizardAtlassianConnectionId}
          isOpen={wizardOpen}
          onOpenChange={(open) => {
            setWizardOpen(open)
            if (!open) {
              void queryClient.invalidateQueries({
                queryKey: orgConnectionsKeys.list(orgSlug),
              })
            }
          }}
        />

        <Modal
          isOpen={scopeOpen}
          onOpenChange={(open) => {
            setScopeOpen(open)
            if (!open) setScopeConnectionId(null)
          }}
          isDismissable
          size="wide"
          className="max-w-[min(92vw,780px)]"
        >
          {scopeConnectionId ? (
            <EditScopeModal
              orgSlug={orgSlug}
              atlassianConnectionId={scopeConnectionId}
              onClose={() => {
                setScopeOpen(false)
                setScopeConnectionId(null)
              }}
            />
          ) : null}
        </Modal>

        <Modal isOpen={claimOpen} onOpenChange={setClaimOpen} isDismissable>
          <h2 className="text-base font-semibold text-zinc-100">
            Connect this Atlassian account?
          </h2>
          <p className="mt-2 text-sm text-zinc-300">
            This Atlassian account is already linked to another user here. If
            you continue, that link is removed and this profile will own the
            connection. You can also sign in as the other user and use User
            account → Unlink Atlassian, then return here.
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onPress={async () => {
                if (!search.pendingAccountClaim) {
                  setClaimOpen(false)
                  return
                }
                const id = encodeURIComponent(search.pendingAccountClaim)
                await fetch(
                  `/${orgSlug}/api/v1/connectors/atlassian/pending-claim/${id}/cancel`,
                  { method: "POST", credentials: "include" },
                )
                setClaimOpen(false)
                void navigate({
                  to: "/$orgSlug/connectors",
                  params: { orgSlug },
                  search: (prev) => ({
                    orgSlug: prev.orgSlug,
                    installation_id: prev.installation_id,
                    setup_action: prev.setup_action,
                    seed: prev.seed,
                    error: prev.error,
                    error_description: prev.error_description,
                    pendingAccountClaim: undefined,
                  }),
                  replace: true,
                })
              }}
            >
              No, cancel
            </Button>
            <Button
              variant="primary"
              onPress={async () => {
                if (!search.pendingAccountClaim) {
                  setClaimOpen(false)
                  return
                }
                const id = encodeURIComponent(search.pendingAccountClaim)
                const res = await fetch(
                  `/${orgSlug}/api/v1/connectors/atlassian/pending-claim/${id}/confirm`,
                  { method: "POST", credentials: "include" },
                )
                if (!res.ok) {
                  setClaimOpen(false)
                  return
                }
                setClaimOpen(false)
                void queryClient.invalidateQueries({
                  queryKey: orgConnectionsKeys.list(orgSlug),
                })
                void navigate({
                  to: "/$orgSlug/connectors",
                  params: { orgSlug },
                  search: (prev) => ({
                    orgSlug: prev.orgSlug,
                    installation_id: prev.installation_id,
                    setup_action: prev.setup_action,
                    seed: prev.seed,
                    error: prev.error,
                    error_description: prev.error_description,
                    pendingAccountClaim: undefined,
                  }),
                  replace: true,
                })
              }}
            >
              Yes, use this profile
            </Button>
          </div>
        </Modal>
      </main>
    </AppShell>
  )
}
