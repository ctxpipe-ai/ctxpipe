import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { AppShell } from "@/components/AppShell"
import { client } from "@/lib/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { useState } from "react"
import { toast } from "sonner"
import { IconBrandGithub } from "@tabler/icons-react"
import {
  AddConnectorModal,
  EditConnectorModal,
  EditScopeModal,
  ConnectorCard,
  type Connector,
} from "@/features/connectors"

export const Route = createFileRoute("/$orgSlug/connectors")({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [connectorToEdit, setConnectorToEdit] = useState<Connector | null>(null)
  const [connectorToScope, setConnectorToScope] = useState<Connector | null>(null)
  const [connectorToDelete, setConnectorToDelete] = useState<Connector | null>(
    null,
  )
  const queryClient = useQueryClient()
  const { orgSlug } = Route.useParams()

  const { data, isPending, error } = useQuery({
    queryKey: ["connectors"],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to fetch connectors")
      const json = (await res.json()) as { items: Connector[] }
      return json.items
    },
  })

  const createMutation = useMutation({
    mutationFn: async (input: {
      type: string
      githubRepoName?: string
      githubBranch?: string
      config: {
        confluenceBaseUrl?: string
        confluenceEmail?: string
        confluenceApiToken?: string
        githubToken?: string
      }
    }) => {
      const res = await client[":orgSlug"].api.v1.connectors.$post({
        json: input,
        param: { orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to create connector",
        )
      }
      return res.json() as Promise<Connector>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      setAddModalOpen(false)
      toast.success("Connector created successfully")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string
      data: {
        githubRepoName?: string
        githubBranch?: string
        spaces?: Array<{ spaceKey: string; spaceName?: string }>
        config?: {
          syncMode?: "pr" | "auto"
          schedule?: "hourly" | "daily" | "manual"
          githubToken?: string
        }
      }
    }) => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"].$patch({
        json: data,
        param: { id, orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to update connector",
        )
      }
      return res.json() as Promise<Connector>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      setConnectorToEdit(null)
      toast.success("Connector updated")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (connectorId: string) => {
      const res = await client[":orgSlug"].api.v1.connectors[":id"].$delete({
        param: { id: connectorId, orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to delete connector",
        )
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      setConnectorToDelete(null)
      toast.success("Connector deleted")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  if (sessionPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  // All connectors share a single repo — surface it at the page level
  const sharedRepo = data?.find((c) => c.githubRepoName)?.githubRepoName ?? null

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Ingestion sources</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Connect external services — content is synced into your GitHub repository as Markdown.
            </p>
          </div>
          <Button variant="primary" onPress={() => setAddModalOpen(true)}>
            Add connector
          </Button>
        </div>

        {/* Shared repository banner */}
        {sharedRepo && (
          <div className="mt-5 flex items-center gap-2.5 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-4 py-2.5 text-sm">
            <IconBrandGithub className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="text-zinc-400">Ingestion repo:</span>
            <a
              href={`https://github.com/${sharedRepo}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-zinc-200 hover:text-teal-400 transition-colors"
            >
              {sharedRepo}
            </a>
          </div>
        )}

        {addModalOpen && (
          <Modal
            isOpen={addModalOpen}
            onOpenChange={setAddModalOpen}
            isDismissable
          >
            <AddConnectorModal
              onClose={() => setAddModalOpen(false)}
              onSubmit={(data) => createMutation.mutate(data)}
              isPending={createMutation.isPending}
              error={createMutation.error?.message}
            />
          </Modal>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-400">
            {error instanceof Error
              ? error.message
              : "Failed to load connectors"}
          </p>
        )}

        {isPending && (
          <p className="mt-4 text-sm text-zinc-400">Loading connectors...</p>
        )}

        {data && data.length === 0 && (
          <p className="mt-6 text-sm text-zinc-500">
            No connectors yet. Add one to start syncing.
          </p>
        )}

        {data && data.length > 0 && (
          <ol className="mt-6 flex flex-col gap-2">
            {data.map((connector) => (
              <li key={connector.id}>
                <ConnectorCard
                  connector={connector}
                  onDelete={setConnectorToDelete}
                  onEdit={(c, tab) =>
                    tab === "scope"
                      ? setConnectorToScope(c)
                      : setConnectorToEdit(c)
                  }
                />
              </li>
            ))}
          </ol>
        )}

        {connectorToEdit && (
          <Modal
            isOpen={!!connectorToEdit}
            onOpenChange={(open) => !open && setConnectorToEdit(null)}
            isDismissable
          >
            <EditConnectorModal
              connector={connectorToEdit}
              onClose={() => setConnectorToEdit(null)}
              onSubmit={(data) =>
                updateMutation.mutate({ id: connectorToEdit.id, data })
              }
              isPending={updateMutation.isPending}
              error={updateMutation.error?.message}
            />
          </Modal>
        )}

        {connectorToScope && (
          <Modal
            isOpen={!!connectorToScope}
            onOpenChange={(open) => !open && setConnectorToScope(null)}
            isDismissable
          >
            <EditScopeModal
              connector={connectorToScope}
              onClose={() => setConnectorToScope(null)}
            />
          </Modal>
        )}

        {connectorToDelete && (
          <Modal
            isOpen={!!connectorToDelete}
            onOpenChange={(open) => !open && setConnectorToDelete(null)}
            isDismissable
          >
            <AlertDialog
              title="Delete connector"
              variant="destructive"
              actionLabel="Delete"
              cancelLabel="Cancel"
              onAction={() => deleteMutation.mutate(connectorToDelete.id)}
            >
              Are you sure you want to delete the connector for "
              {connectorToDelete.type}"? This action cannot be undone.
            </AlertDialog>
          </Modal>
        )}
      </main>
    </AppShell>
  )
}
