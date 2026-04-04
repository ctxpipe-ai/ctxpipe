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
import { useSession } from "@/lib/auth-client"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

export const Route = createFileRoute("/$orgSlug/repositories/")({
  component: RepositoriesPage,
})

const repoActionBtnClass = "h-9 gap-2 rounded-none"
type GitHubConnectedRepo = {
  id: number
  full_name: string
  html_url: string
}
type GitHubReposPreview = {
  repositories: GitHubConnectedRepo[]
  error: string | null
}
type GitHubSetupData = {
  savedRepositories: Array<{ name: string; gitUrl: string }>
}

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
    <Button
      variant="primary"
      className={repoActionBtnClass}
      onPress={onConnectInstall}
    >
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
  const watchPopupClose = useWatchPopupClose()

  const githubAppInstallUrl = useGetGithubAppInstallUrl()

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
    refetchInterval: (query) => {
      if (!installation) return false
      const items = (query.state.data as Repository[] | undefined) ?? []
      return items.length === 0 ? 3000 : false
    },
  })
  const { data: githubPreview } = useQuery({
    queryKey: ["github-installation-repos-preview", orgSlug],
    queryFn: async () => {
      const res = await (
        client[
          ":orgSlug"
        ].api.v1.github.installation.repositories.$get as (arg: {
          param: { orgSlug: string }
          query: { page: string; per_page: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        query: { page: "1", per_page: "100" },
      })
      if (res.status === 404) {
        return { repositories: [], error: null } satisfies GitHubReposPreview
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        return {
          repositories: [],
          error: json.error ?? "Failed to fetch connected GitHub repositories",
        } satisfies GitHubReposPreview
      }
      const json = (await res.json()) as {
        repositories: GitHubConnectedRepo[]
      }
      return {
        repositories: json.repositories,
        error: null,
      } satisfies GitHubReposPreview
    },
    enabled: !!installation,
  })
  const { data: githubSetupData } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to fetch GitHub setup details")
      return (await res.json()) as GitHubSetupData
    },
    enabled: !!installation,
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

  const handleConnectGithubInstall = () => {
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: GITHUB_POPUP_NAME,
      width: 1120,
      height: 780,
    })
    if (!popup) return

    watchPopupClose(popup, () =>
      handleGithubSetupPopupResult(orgSlug, queryClient),
    )
  }

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as { id: string; onboardingCompletedAt?: string | null }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  const repos = data ?? []
  const hasRepos = repos.length > 0
  const indexedReposCount = repos.filter((repo) => repo.indexReady).length
  const allReposIndexed = hasRepos && indexedReposCount === repos.length
  const connectedGithubRepos = githubPreview?.repositories ?? []
  const githubPreviewError = githubPreview?.error ?? null
  const hasConnectedGithubRepos = connectedGithubRepos.length > 0
  const savedSetupRepos = githubSetupData?.savedRepositories ?? []
  const hasSavedSetupRepos = savedSetupRepos.length > 0
  const hasPendingGithubRepos = hasConnectedGithubRepos || hasSavedSetupRepos

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
                    <span className="ctx-connected">
                      {allReposIndexed ? "indexed" : "indexing"}
                    </span>
                  ) : null}
                </div>
                <p className="mt-3 leading-relaxed text-muted-foreground">
                  {hasRepos
                    ? allReposIndexed
                      ? `${repos.length} ${repos.length === 1 ? "repository" : "repositories"} indexed`
                      : `${repos.length} ${repos.length === 1 ? "repository" : "repositories"} connected, ${indexedReposCount} indexed`
                    : hasPendingGithubRepos
                      ? `${hasConnectedGithubRepos ? connectedGithubRepos.length : savedSetupRepos.length} ${hasConnectedGithubRepos ? connectedGithubRepos.length === 1 ? "repository" : "repositories" : savedSetupRepos.length === 1 ? "repository" : "repositories"} selected in GitHub. Ingestion is in progress.`
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
            {!error && githubPreviewError ? (
              <p className="text-sm text-amber-300">{githubPreviewError}</p>
            ) : null}

            {isPending ? (
              <p className="text-sm text-muted-foreground">
                Loading repositories…
              </p>
            ) : null}

            {!isPending && !error && !hasRepos && hasPendingGithubRepos ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Repositories selected in GitHub App (pending ingestion):
                </p>
                <ul className="w-full list-none space-y-2 p-0">
                  {hasConnectedGithubRepos
                    ? connectedGithubRepos.map((repo) => (
                        <li
                          key={repo.id}
                          className="flex items-center justify-between rounded-none border border-border bg-card/40 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">
                              {repo.full_name}
                            </p>
                            <a
                              href={repo.html_url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-xs text-muted-foreground hover:text-foreground"
                            >
                              {repo.html_url}
                            </a>
                          </div>
                          <span className="ml-3 shrink-0 text-xs text-amber-300">
                            pending
                          </span>
                        </li>
                      ))
                    : savedSetupRepos.map((repo) => (
                        <li
                          key={repo.gitUrl}
                          className="flex items-center justify-between rounded-none border border-border bg-card/40 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">
                              {repo.name}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {repo.gitUrl}
                            </p>
                          </div>
                          <span className="ml-3 shrink-0 text-xs text-amber-300">
                            pending
                          </span>
                        </li>
                      ))}
                </ul>
              </div>
            ) : null}

            {!isPending && !error && !hasRepos && !hasPendingGithubRepos ? (
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
