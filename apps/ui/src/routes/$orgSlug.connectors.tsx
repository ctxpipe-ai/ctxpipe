import { IconPlus } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useState } from "react"
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
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/connectors")({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()
  const queryClient = useQueryClient()
  const [catalogOpen, setCatalogOpen] = useState(false)
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
    enabled: Boolean(session),
  })

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

  const items = connections ?? []
  const showPageLoading = connectionsPending && !connections
  const showEmptyState = !showPageLoading && items.length === 0

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
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
      </main>
    </AppShell>
  )
}
