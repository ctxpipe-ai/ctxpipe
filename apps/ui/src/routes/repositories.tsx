import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import { AppShell } from "@/components/AppShell"
import { client } from "@/lib/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { IconPlus } from "@tabler/icons-react"
import { useSession } from "@/lib/auth-client"
import { useState } from "react"
import { toast } from "sonner"

export const Route = createFileRoute("/repositories")({
  component: RepositoriesPage,
})

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString()
}

type Repository = {
  id: string
  orgId: string
  zoektRepoId: number
  name: string
  gitUrl: string
  indexReady: boolean
  lastIngestedHash: string | null
  createdAt: string
  updatedAt: string
}

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
          <Button
            variant="primary"
            onPress={() => setAddModalOpen(true)}
            className="flex items-center gap-2"
          >
            <IconPlus className="h-4 w-4" aria-hidden />
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
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

function RepositoryCard({ repo }: { repo: Repository }) {
  const status = repo.indexReady ? "Ready" : "Pending"
  const lastIndexed =
    repo.indexReady && repo.updatedAt ? formatDate(repo.updatedAt) : "—"
  const hashShort =
    repo.lastIngestedHash != null ? repo.lastIngestedHash.slice(0, 7) : null

  return (
    <Card className="border-zinc-800/90 bg-zinc-900/70 shadow-lg">
      <CardHeader>
        <CardTitle className="text-zinc-50">{repo.name}</CardTitle>
        <CardDescription
          className="font-mono text-xs text-zinc-400 truncate"
          title={repo.gitUrl}
        >
          {repo.gitUrl}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Index status</span>
          <span
            className={repo.indexReady ? "text-emerald-400" : "text-amber-400"}
          >
            {status}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Last indexed</span>
          <span className="text-zinc-300" title={repo.updatedAt}>
            {lastIndexed}
          </span>
        </div>
        {hashShort != null && (
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Commit</span>
            <span
              className="font-mono text-zinc-400"
              title={repo.lastIngestedHash ?? undefined}
            >
              {hashShort}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-zinc-500">Created</span>
          <span className="text-zinc-400" title={repo.createdAt}>
            {formatDate(repo.createdAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function AddRepositoryModal({
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  onClose: () => void
  onSubmit: (name: string, gitUrl: string) => void
  isPending: boolean
  error: string | undefined
}) {
  const [name, setName] = useState("")
  const [gitUrl, setGitUrl] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    const g = gitUrl.trim()
    if (n && g) onSubmit(n, g)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 p-6 text-zinc-100"
    >
      <h2 className="text-lg font-semibold">Add repository</h2>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <TextField
        label="Name"
        name="name"
        value={name}
        onChange={setName}
        placeholder="my-repo"
        description="Display name for the repository"
        isRequired
      />
      <TextField
        label="Git URL"
        name="gitUrl"
        value={gitUrl}
        onChange={setGitUrl}
        placeholder="https://github.com/org/repo.git"
        description="Clone URL (HTTPS or SSH)"
        type="url"
        isRequired
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onPress={onClose} type="button">
          Cancel
        </Button>
        <Button variant="primary" type="submit" isDisabled={isPending}>
          {isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </form>
  )
}
