import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { AppShell } from "@/components/AppShell"
import {
  AddRepositoryModal,
  RepositoryCard,
  type Repository,
} from "@/features/repositories"
import { client } from "@/lib/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { Dialog, DialogTitle, DialogDescription } from "@/components/ui/Dialog"
import { useState } from "react"
import { toast } from "sonner"
import { IconDots } from "@tabler/icons-react"

export const Route = createFileRoute("/$orgSlug/repositories")({
  component: RepositoriesPage,
})

function RepositoriesPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null)
  const queryClient = useQueryClient()
  const { orgSlug } = Route.useParams()
  const navigate = useNavigate()

  const { data: installation } = useQuery({
    queryKey: ["github-installation", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.github.installation.$get({
        param: { orgSlug },
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to check GitHub installation")
      return res.json()
    },
  })

  const { data, isPending, error } = useQuery({
    queryKey: ["repositories"],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as { items: Repository[] }
      return json.items
    },
  })

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; gitUrl: string }) => {
      const res = await client[":orgSlug"].api.v1.repositories.$post({
        json: input,
        param: { orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to create repository",
        )
      }
      return res.json() as Promise<Repository>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories"] })
      setAddModalOpen(false)
      toast.success("Repository added and indexing started")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (repoId: string) => {
      const res = await client[":orgSlug"].api.v1.repositories[":id"].$delete({
        param: { id: repoId, orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to delete repository",
        )
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories"] })
      setRepoToDelete(null)
      toast.success("Repository deleted")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <div className="flex gap-2">
            {installation ? (
              <Button
                variant="primary"
                onPress={() =>
                  navigate({
                    to: "/$orgSlug/github/setup",
                    params: { orgSlug },
                  })
                }
              >
                Manage GitHub App
              </Button>
            ) : (
              <Button variant="primary" onPress={() => setConnectModalOpen(true)}>
                Connect with GitHub
              </Button>
            )}
            <MenuTrigger>
              <Button variant="secondary">
                <IconDots className="h-4 w-4" />
              </Button>
              <Menu>
                <MenuItem onAction={() => setAddModalOpen(true)}>
                  Add individual repository
                </MenuItem>
              </Menu>
            </MenuTrigger>
          </div>
        </div>

        {addModalOpen && (
          <Modal
            isOpen={addModalOpen}
            onOpenChange={setAddModalOpen}
            isDismissable
          >
            <AddRepositoryModal
              onClose={() => setAddModalOpen(false)}
              onSubmit={(name, gitUrl) =>
                createMutation.mutate({ name, gitUrl })
              }
              isPending={createMutation.isPending}
              error={createMutation.error?.message}
            />
          </Modal>
        )}

        <Modal
          isOpen={connectModalOpen}
          onOpenChange={setConnectModalOpen}
          isDismissable
        >
          <Dialog>
            <DialogTitle>Connect with GitHub</DialogTitle>
            <DialogDescription className="mt-2">
              Instructions for connecting with GitHub will go here.
            </DialogDescription>
            <div className="mt-6 flex justify-end">
              <Button variant="secondary" onPress={() => setConnectModalOpen(false)}>
                Close
              </Button>
            </div>
          </Dialog>
        </Modal>

        {error && (
          <p className="text-sm text-red-400">
            {error instanceof Error
              ? error.message
              : "Failed to load repositories"}
          </p>
        )}

        {isPending && (
          <p className="text-sm text-zinc-400">Loading repositories…</p>
        )}

        {data && data.length === 0 && (
          <p className="text-sm text-zinc-400">
            No repositories yet. Add one to start indexing.
          </p>
        )}

        {data && data.length > 0 && (
          <ol className="mt-8 flex flex-col gap-3">
            {data.map((repo) => (
              <li key={repo.id}>
                <RepositoryCard repo={repo} onDelete={setRepoToDelete} />
              </li>
            ))}
          </ol>
        )}

        {repoToDelete && (
          <Modal
            isOpen={!!repoToDelete}
            onOpenChange={(open) => !open && setRepoToDelete(null)}
            isDismissable
          >
            <AlertDialog
              title="Delete repository"
              variant="destructive"
              actionLabel="Delete"
              cancelLabel="Cancel"
              onAction={() => deleteMutation.mutate(repoToDelete.id)}
            >
              Are you sure you want to delete "{repoToDelete.name}"? This action
              cannot be undone.
            </AlertDialog>
          </Modal>
        )}
      </main>
    </AppShell>
  )
}
