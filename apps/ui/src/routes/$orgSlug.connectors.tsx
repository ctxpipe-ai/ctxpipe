import { IconPlus } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { InlineLoader } from "@/components/ui/InlineLoader"
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
import { AtlassianAccountClaimModalContent } from "@/features/connectors/components/AtlassianAccountClaimModalContent"
import { ConnectorsOAuthErrorBanner } from "@/features/connectors/components/ConnectorsOAuthErrorBanner"
import { atlassianConnectorKeys } from "@/features/connectors/queries/atlassian-connector"
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
        <main className="mx-auto flex w-full max-w-2xl items-center justify-center p-8">
          <Spinner className="text-muted-foreground" />
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
      <main className="mx-auto box-border flex min-h-full w-full max-w-2xl flex-col p-8 text-foreground">
        {errorBanner ? (
          <ConnectorsOAuthErrorBanner
            title={errorBanner.title}
            description={errorBanner.description}
          />
        ) : null}
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Connectors
          </span>
        </header>

        <section>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
            <div className="min-w-0 flex-1">
              <h1 className="text-3xl font-medium tracking-tight text-foreground">
                Connectors
              </h1>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                Connect external tools and choose what content ctxpipe should
                ingest.
              </p>
            </div>
            {!showEmptyState ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
                <Button
                  variant="secondary"
                  size="icon"
                  className="rounded-none"
                  aria-label="Add connection"
                  onPress={() => setCatalogOpen(true)}
                >
                  <IconPlus className="size-5" aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-12 flex min-h-0 flex-col gap-3">
          {showPageLoading ? (
            <InlineLoader label="Loading connectors" />
          ) : showEmptyState ? (
            <ConnectorsEmptyState
              onAddConnection={() => setCatalogOpen(true)}
            />
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
          <AtlassianAccountClaimModalContent
            onCancel={async () => {
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
            onConfirm={async () => {
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
              await queryClient.invalidateQueries({
                queryKey: orgConnectionsKeys.list(orgSlug),
              })
              await queryClient.invalidateQueries({
                queryKey: atlassianConnectorKeys.allStatusForOrg(orgSlug),
              })
              await queryClient.invalidateQueries({
                queryKey: atlassianConnectorKeys.allConfigForOrg(orgSlug),
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
          />
        </Modal>
      </main>
    </AppShell>
  )
}
