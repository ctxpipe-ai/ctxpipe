import { IconBrandGithub, IconDots, IconGitBranch } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/AppShell"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import {
  AddRepositoryModal,
  type Repository,
  RepositoryCard,
} from "@/features/repositories"
import { client } from "@/lib/api"
import { onPopupClosed, openCenteredPopup } from "@/lib/popup"
import { useSession } from "@/lib/auth-client"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

export const Route = createFileRoute("/$orgSlug/repositories/")({
  component: RepositoriesPage,
})

const repoActionBtnClass = "h-9 gap-2 rounded-none"

function GitHubConnectButton(props: {
  installation: unknown
  orgSlug: string
  onConnectInstall: () => void
  navigate: ReturnType<typeof useNavigate>
}) {
  const { installation, orgSlug, onConnectInstall, navigate } = props
  if (installation) {
    return (
      <Button
        variant="primary"
        className={repoActionBtnClass}
        onPress={() =>
          navigate({
            to: "/$orgSlug/repositories/github/setup",
            params: { orgSlug },
          })
        }
      >
        <IconBrandGithub className="h-4 w-4" />
        Manage GitHub App
      </Button>
    )
  }
  return (
    <Button variant="primary" className={repoActionBtnClass} onPress={onConnectInstall}>
      <IconBrandGithub className="h-4 w-4" />
      Connect GitHub
    </Button>
  )
}

function RepositoriesPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null)
  const queryClient = useQueryClient()
  const { orgSlug } = Route.useParams()
  const navigate = useNavigate()

  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const handleConnectGithubInstall = () => {
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: "github-app-install",
      width: 1120,
      height: 780,
    })
    if (!popup) return

    onPopupClosed(popup, () => {
      void queryClient.invalidateQueries({ queryKey: ["github-installation", orgSlug] })
    })
  }

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
    queryKey: ["repositories", orgSlug],
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
      queryClient.invalidateQueries({ queryKey: ["repositories", orgSlug] })
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
      queryClient.invalidateQueries({ queryKey: ["repositories", orgSlug] })
      setRepoToDelete(null)
      toast.success("Repository deleted")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const repos = data ?? []
  const hasRepos = repos.length > 0

  return (
    <AppShell>
      <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
        <div className="mx-auto box-border flex w-full max-w-2xl flex-1 flex-col p-8">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              Repositories
            </span>
          </header>

          <section>
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-medium tracking-tight text-foreground">
                    Git sources
                  </h1>
                  {hasRepos ? (
                    <span className="ctx-connected">indexed</span>
                  ) : null}
                </div>
                <p className="mt-3 leading-relaxed text-muted-foreground">
                  {hasRepos
                    ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"} connected`
                    : "Connect your Git accounts to start ingesting repositories."}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
                <GitHubConnectButton
                  installation={installation}
                  orgSlug={orgSlug}
                  onConnectInstall={handleConnectGithubInstall}
                  navigate={navigate}
                />
                <MenuTrigger
                  placement="bottom end"
                  popoverClassName="rounded-none border-border bg-card"
                >
                  <Button
                    variant="secondary"
                    size="icon"
                    className="rounded-none"
                    aria-label="More repository actions"
                  >
                    <IconDots className="h-4 w-4" />
                  </Button>
                  <Menu>
                    <MenuItem
                      onAction={() => setAddModalOpen(true)}
                      textValue="Add individual repository"
                    >
                      Add individual repository
                    </MenuItem>
                  </Menu>
                </MenuTrigger>
              </div>
            </div>
          </section>

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

          <div className="mt-12 w-full flex-1">
            {error ? (
              <p className="text-sm text-destructive">
                {error instanceof Error
                  ? error.message
                  : "Failed to load repositories"}
              </p>
            ) : null}

            {isPending ? (
              <p className="text-sm text-muted-foreground">
                Loading repositories…
              </p>
            ) : null}

            {!isPending && !error && !hasRepos ? (
              <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
                <div className="max-w-md">
                  <div className="ctx-node mx-auto mb-6 h-10 w-10">
                    <IconGitBranch
                      aria-hidden
                      className="h-4 w-4 text-muted-foreground"
                    />
                  </div>
                  <h2 className="text-xl font-medium tracking-tight text-foreground">
                    No repositories
                  </h2>
                  <p className="mt-3 leading-relaxed text-muted-foreground">
                    Connect your GitHub account to index repositories into the
                    knowledge graph. Git is the source of truth.
                  </p>
                </div>
              </div>
            ) : null}

            {!isPending && !error && hasRepos ? (
              <ul className="w-full list-none space-y-1 p-0">
                {repos.map((repo) => (
                  <li key={repo.id} className="w-full">
                    <RepositoryCard repo={repo} onDelete={setRepoToDelete} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

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
                Are you sure you want to delete "{repoToDelete.name}"? This
                action cannot be undone.
              </AlertDialog>
            </Modal>
          )}
        </div>
      </div>
    </AppShell>
  )
}
