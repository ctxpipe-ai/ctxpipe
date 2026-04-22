import { IconPlus } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useState } from "react"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  AddConnectorCatalogDialog,
  ConfluenceConnectionCard,
  ConnectorSetupDialog,
  ConnectorsEmptyState,
  EditScopeModal,
} from "@/features/connectors"
import { hasConfluenceConnectionRow } from "@/features/connectors/confluence-setup-model"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorStatus,
} from "@/features/connectors/queries/atlassian-connector"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/connectors")({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)

  const { data: status, isPending: statusPending } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug),
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

  const showConfluenceCard = hasConfluenceConnectionRow(status)
  const showPageLoading = statusPending && !status
  const showEmptyState = !showPageLoading && !showConfluenceCard

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

        <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {showPageLoading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-400 lg:col-span-2">
              <Spinner className="size-4" />
              Loading connections…
            </div>
          ) : showConfluenceCard ? (
            <ConfluenceConnectionCard
              orgSlug={orgSlug}
              onOpenWizard={() => setWizardOpen(true)}
              onOpenScope={() => setScopeOpen(true)}
            />
          ) : (
            <div className="lg:col-span-2">
              <ConnectorsEmptyState
                onAddConnection={() => setCatalogOpen(true)}
              />
            </div>
          )}
        </section>

        <AddConnectorCatalogDialog
          isOpen={catalogOpen}
          onOpenChange={setCatalogOpen}
          onPickConfluence={() => setWizardOpen(true)}
        />

        <ConnectorSetupDialog
          orgSlug={orgSlug}
          isOpen={wizardOpen}
          onOpenChange={setWizardOpen}
        />

        <Modal
          isOpen={scopeOpen}
          onOpenChange={setScopeOpen}
          isDismissable
          size="wide"
          className="max-w-[min(92vw,780px)]"
        >
          <EditScopeModal
            orgSlug={orgSlug}
            onClose={() => setScopeOpen(false)}
          />
        </Modal>
      </main>
    </AppShell>
  )
}
