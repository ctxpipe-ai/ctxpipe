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
  RepositoryStatus,
} from "@/features/repositories"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
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
  clone_url: string
  name: string
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
  onConnectInstall: () => void
}) {
  const { installation, onConnectInstall } = props
  if (installation) {
    return (
      <Button
        variant="primary"
        className={repoActionBtnClass}
        onPress={onConnectInstall}
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
  const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null)
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
      queryClient.invalidateQueries({
        queryKey: ["github-installation-repos-preview", orgSlug],
      })
      queryClient.invalidateQueries({
        queryKey: ["github-installation-setup", orgSlug],
      })
      setRepoToDelete(null)
      toast.success("Repository unindexed")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
    onSettled: () => {
      setDeletingRepoId(null)
    },
  })

  const handleConfirmDelete = () => {
    if (!repoToDelete || deleteMutation.isPending) return
    setDeletingRepoId(repoToDelete.id)
    deleteMutation.mutate(repoToDelete.id)
  }

  const handleConnectGithubInstall = () => {
    setGithubSetupOrgHint(orgSlug)
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
  const savedSetupRepos = githubSetupData?.savedRepositories ?? []
  const existingGitUrls = new Set(repos.map((repo) => repo.gitUrl))
  const pendingConnectedGithubRepos = connectedGithubRepos.filter(
    (repo) => !existingGitUrls.has(repo.clone_url),
  )
  const pendingSavedSetupRepos = savedSetupRepos.filter(
    (repo) => !existingGitUrls.has(repo.gitUrl),
  )
  const hasConnectedGithubRepos = pendingConnectedGithubRepos.length > 0
  const hasSavedSetupRepos = pendingSavedSetupRepos.length > 0
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
                </div>
                <p className="mt-3 leading-relaxed text-muted-foreground">
                  Connect your GitHub account to manage which repositories are
                  ingested into ctx| knowledge.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">
                <GitHubConnectButton
                  installation={installation}
                  onConnectInstall={handleConnectGithubInstall}
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
                    {installation ? (
                      <MenuItem
                        onAction={() =>
                          navigate({
                            to: "/$orgSlug/repositories/github/setup",
                            params: { orgSlug },
                          })
                        }
                        textValue="Configure repository selection"
                        className="rounded-none text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800"
                      >
                        Configure repository selection
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      onAction={() => setAddModalOpen(true)}
                      textValue="Add individual repository"
                      className="rounded-none text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800"
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

            {!isPending && !error && hasPendingGithubRepos ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Repositories selected in GitHub App (pending indexing):
                </p>
                <ul className="w-full list-none space-y-2 p-0">
                  {hasConnectedGithubRepos
                    ? pendingConnectedGithubRepos.map((repo) => (
                        <li
                          key={repo.id}
                          className="ctx-repo-row group"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-4">
                            <div className="ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground [&_svg]:transition-colors group-hover:[&_svg]:text-teal-400">
                              <IconGitBranch
                                aria-hidden
                                className="h-4 w-4 text-muted-foreground"
                              />
                            </div>
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
                          </div>
                          <div className="flex shrink-0 items-center gap-4 sm:gap-6">
                            <RepositoryStatus status="pending-indexing" />
                            <MenuTrigger
                              placement="bottom end"
                              popoverClassName="rounded-none border-border bg-card"
                            >
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="rounded-none"
                                aria-label="Pending repository actions"
                                isDisabled={createMutation.isPending}
                              >
                                <IconDots className="h-4 w-4" />
                              </Button>
                              <Menu>
                                <MenuItem
                                  onAction={() =>
                                    createMutation.mutate({
                                      name: repo.full_name,
                                      gitUrl: repo.clone_url,
                                    })
                                  }
                                  textValue="Index now"
                                  className="rounded-none text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800"
                                >
                                  Index now
                                </MenuItem>
                              </Menu>
                            </MenuTrigger>
                          </div>
                        </li>
                      ))
                    : pendingSavedSetupRepos.map((repo) => (
                        <li
                          key={repo.gitUrl}
                          className="ctx-repo-row group"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-4">
                            <div className="ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out group-hover:border-teal-400 group-hover:bg-teal-400/5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground [&_svg]:transition-colors group-hover:[&_svg]:text-teal-400">
                              <IconGitBranch
                                aria-hidden
                                className="h-4 w-4 text-muted-foreground"
                              />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm text-foreground">
                                {repo.name}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {repo.gitUrl}
                              </p>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-4 sm:gap-6">
                            <RepositoryStatus status="pending-indexing" />
                            <MenuTrigger
                              placement="bottom end"
                              popoverClassName="rounded-none border-border bg-card"
                            >
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="rounded-none"
                                aria-label="Pending repository actions"
                                isDisabled={createMutation.isPending}
                              >
                                <IconDots className="h-4 w-4" />
                              </Button>
                              <Menu>
                                <MenuItem
                                  onAction={() =>
                                    createMutation.mutate({
                                      name: repo.name,
                                      gitUrl: repo.gitUrl,
                                    })
                                  }
                                  textValue="Index now"
                                  className="rounded-none text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800"
                                >
                                  Index now
                                </MenuItem>
                              </Menu>
                            </MenuTrigger>
                          </div>
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
                    <RepositoryCard
                      repo={repo}
                      onDelete={setRepoToDelete}
                      isDeleting={deletingRepoId === repo.id}
                    />
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
                title="Unindex repository"
                variant="destructive"
                actionLabel="Unindex"
                cancelLabel="Cancel"
                onAction={handleConfirmDelete}
              >
                Are you sure you want to unindex "{repoToDelete.name}"? If this
                repository is still selected in GitHub App, it may appear again
                as pending indexing.
              </AlertDialog>
            </Modal>
          )}
        </div>
      </div>
    </AppShell>
  )
}
