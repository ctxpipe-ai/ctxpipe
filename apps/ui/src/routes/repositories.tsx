import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { AppShell } from "@/components/AppShell"
import {
  AddRepositoryModal,
  RepositoryCard,
  type Repository,
} from "@/features/repositories"
import { client } from "@/lib/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { useState } from "react"
import { toast } from "sonner"

export const Route = createFileRoute("/repositories")({
  component: RepositoriesPage,
})

function RepositoriesPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const queryClient = useQueryClient()

  const { data, isPending, error } = useQuery({
    queryKey: ["repositories"],
    queryFn: async () => {
      const res = await client.api.v1.repositories.$get({ query: {} })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as { items: Repository[] }
      return json.items
    },
  })

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; gitUrl: string }) => {
      const res = await client.api.v1.repositories.$post({ json: input })
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

  if (sessionPending) return null
  if (!session) return <Navigate to="/sign-in" replace />

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <Button variant="primary" onPress={() => setAddModalOpen(true)}>
            Add repository
          </Button>
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
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((repo) => (
              <li key={repo.id}>
                <RepositoryCard repo={repo} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </AppShell>
  )
}
