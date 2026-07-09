import { IconDots, IconGitBranch } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/AppShell"
import { McpConfigPrWizard } from "@/components/onboarding/McpConfigPrWizard"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Menu, MenuItem, MenuSection, MenuTrigger } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  AddRepositoryModal,
  type Repository,
  RepositoryCard,
  RepositoryStatus,
} from "@/features/repositories"
import { githubRepoFullNameFromGitUrl } from "@/features/repositories/github-web-url"
import { derivePendingGithubRepos } from "@/features/repositories/pendingGithubRepos"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/repositories/")({
  component: RepositoriesPage,
})

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
  warning?: string | null
}
type GitHubSetupData = {
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  savedRepositories: Array<{ name: string; gitUrl: string }>
}

function RepositoriesPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [mcpInstallModalOpen, setMcpInstallModalOpen] = useState(false)
  const [repoToDelete, setRepoToDelete] = useState<Repository | null>(null)
  const [retryingRepoId, setRetryingRepoId] = useState<string | null>(null)
  const postRegisterNavigateToSetup = useRef(false)
  const queryClient = useQueryClient()
  const { orgSlug } = Route.useParams()
  const navigate = useNavigate()

  const goToGithubSetup = () => {
    void navigate({
      to: "/$orgSlug/repositories/github/setup",
      params: { orgSlug },
    })
  }

  const {
    start,
    isPending: ghFlowPending,
    isSyncing,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => goToGithubSetup(),
    onRegistered: () => {
      if (postRegisterNavigateToSetup.current) goToGithubSetup()
    },
  })

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
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
      const items = (query.state.data as Repository[] | undefined) ?? []
      const hasIndexingRepos = items.some((repo) => {
        const status = repo.indexingStatus
        return (
          status === "queued" ||
          status === "running" ||
          status === "unindexing"
        )
      })
      return hasIndexingRepos ? 3000 : false
    },
  })
  const { data: githubPreview } = useQuery({
    queryKey: ["github-installation-repos-preview", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.repositories
          .$get as (arg: {
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
        const json = (await res.json().catch(() => ({}))) as {
          code?: string
          error?: string
        }
        return {
          repositories: [],
          error:
            json.code === "GITHUB_INSTALLATION_UNAVAILABLE"
              ? "GitHub needs to be reconnected from the Connectors page."
              : (json.error ?? "Failed to fetch connected GitHub repositories"),
        } satisfies GitHubReposPreview
      }
      const json = (await res.json()) as {
        repositories: GitHubConnectedRepo[]
        warning?: string
      }
      return {
        repositories: json.repositories,
        error: null,
        warning: json.warning ?? null,
      } satisfies GitHubReposPreview
    },
    enabled: !!installation,
  })
  const { data: githubSetupData, isPending: githubSetupPending } = useQuery({
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
    onMutate: async (repoId) => {
      await queryClient.cancelQueries({ queryKey: ["repositories", orgSlug] })
      const previous = queryClient.getQueryData<Repository[]>([
        "repositories",
        orgSlug,
      ])
      queryClient.setQueryData<Repository[]>(
        ["repositories", orgSlug],
        (old) =>
          old?.map((r) =>
            r.id === repoId
              ? { ...r, indexingStatus: "unindexing", indexReady: false }
              : r,
          ),
      )
      return { previous }
    },
    onError: (err, _repoId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["repositories", orgSlug],
          context.previous,
        )
      }
      toast.error(err.message)
    },
    onSuccess: () => {
      setRepoToDelete(null)
      toast.success("Repository unindex queued")
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", orgSlug] })
      queryClient.invalidateQueries({
        queryKey: ["github-installation-repos-preview", orgSlug],
      })
      queryClient.invalidateQueries({
        queryKey: ["github-installation-setup", orgSlug],
      })
    },
  })

  const retryMutation = useMutation({
    mutationFn: async (repoId: string) => {
      const res = await client[":orgSlug"].api.v1.repositories[
        ":id"
      ].reindex.$post({
        param: { id: repoId, orgSlug },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(
          (err as { error?: string }).error ?? "Failed to retry repository indexing",
        )
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repositories", orgSlug] })
      toast.success("Retry indexing queued")
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
    onSettled: () => {
      setRetryingRepoId(null)
    },
  })

  const handleConfirmDelete = () => {
    if (!repoToDelete || deleteMutation.isPending) return
    deleteMutation.mutate(repoToDelete.id)
  }

  const handleConnectGithubInstall = (
    intent: "connect" | "manage_scope" = "connect",
  ) => {
    postRegisterNavigateToSetup.current = false
    start(intent)
  }

  const handleConnectGithubFromEmptyState = () => {
    if (installationPending || ghFlowPending || isSyncing) return
    if (installation) {
      goToGithubSetup()
      return
    }
    postRegisterNavigateToSetup.current = true
    start("connect")
  }

  const githubConnectBusy = installationPending || ghFlowPending || isSyncing

  const repos = data ?? []
  const ingestedGithubRepoFullNames = useMemo(() => {
    const names: string[] = []
    for (const repo of repos) {
      const full = githubRepoFullNameFromGitUrl(repo.gitUrl)
      if (full) names.push(full)
    }
    return names
  }, [repos])

  if (sessionPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border flex min-h-screen w-full max-w-2xl items-center justify-center p-8 text-zinc-100">
          <p className="text-sm text-zinc-400">Loading repositories…</p>
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" search={{ orgSlug }} replace />
  }
  const hasRepos = repos.length > 0
  const connectedGithubRepos = githubPreview?.repositories ?? []
  const githubPreviewError = githubPreview?.error ?? null
  const githubPreviewWarning = githubPreview?.warning ?? null
  const savedSetupRepos = githubSetupData?.savedRepositories ?? []
  const existingGitUrls = new Set(repos.map((repo) => repo.gitUrl))
  const { pendingConnectedGithubRepos, pendingSavedSetupRepos } =
    derivePendingGithubRepos({
      connectedGithubRepos,
      savedSetupRepos,
      existingGitUrls,
      setupData: githubSetupData,
      setupPending: Boolean(installation) && githubSetupPending,
    })
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
                <MenuTrigger
                  placement="bottom end"
                  popoverClassName="min-w-[176px] overflow-hidden rounded-none border-zinc-800 bg-zinc-950"
                >
                  <Button
                    variant="secondary"
                    size="icon"
                    className="rounded-none"
                    aria-label="More repository actions"
                  >
                    <IconDots className="h-4 w-4" />
                  </Button>
                  <Menu className="rounded-none">
                    <MenuSection title="GitHub integration">
                      <MenuItem
                        onAction={() =>
                          navigate({
                            to: "/$orgSlug/repositories/github/setup",
                            params: { orgSlug },
                          })
                        }
                        textValue="Select repositories"
                        className="rounded-none px-3 py-2 text-zinc-100"
                      >
                        Select repositories
                      </MenuItem>
                      <MenuItem
                        isDisabled={!installation}
                        onAction={() => {
                          if (!installation) return
                          setMcpInstallModalOpen(true)
                        }}
                        textValue="Install MCP via pull requests"
                        className="rounded-none px-3 py-2 text-zinc-100"
                      >
                        Install MCP via PRs
                      </MenuItem>
                      <MenuItem
                        onAction={() => handleConnectGithubInstall("manage_scope")}
                        textValue="Manage"
                        className="rounded-none px-3 py-2 text-zinc-100"
                      >
                        Manage
                      </MenuItem>
                    </MenuSection>
                    <MenuSection title="Manual git">
                      <MenuItem
                        onAction={() => setAddModalOpen(true)}
                        textValue="Add single repository"
                        className="rounded-none px-3 py-2 text-zinc-100"
                      >
                        Add single repository
                      </MenuItem>
                    </MenuSection>
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

          {mcpInstallModalOpen && installation ? (
            <Modal
              isOpen={mcpInstallModalOpen}
              onOpenChange={setMcpInstallModalOpen}
              isDismissable
              size="wide"
            >
              <div className="flex max-h-[min(85vh,calc(var(--visual-viewport-height)*0.88))] flex-col overflow-hidden p-6 text-left sm:p-8">
                <div className="mb-6 shrink-0 border-b border-zinc-800 pb-4">
                  <h2 className="text-lg font-medium tracking-tight text-zinc-100">
                    Install MCP config in repositories
                  </h2>
                  <p className="mt-2 text-sm text-zinc-500">
                    Opens GitHub pull requests that add or merge ctx| MCP server
                    entries. Already-ingested GitHub sources are pre-selected;
                    adjust the list if you need other repos from your
                    installation.
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <McpConfigPrWizard
                    variant="standalone"
                    orgSlug={orgSlug}
                    hasGithubInstallation
                    initialSelectedRepoFullNames={ingestedGithubRepoFullNames}
                    repoListMaxHeightClass="max-h-56 sm:max-h-64"
                    onCancel={() => setMcpInstallModalOpen(false)}
                  />
                </div>
              </div>
            </Modal>
          ) : null}

          <div className="mt-12 w-full flex-1">
            {error ? (
              <p className="text-sm text-destructive">
                {error instanceof Error
                  ? error.message
                  : "Failed to load repositories"}
              </p>
            ) : null}
            {!error &&
            !hasRepos &&
            (githubPreviewError || githubPreviewWarning) ? (
              <p className="text-sm text-amber-300">
                {githubPreviewError ?? githubPreviewWarning}
              </p>
            ) : null}

            {isPending ? <InlineLoader label="Loading repositories" /> : null}

            {!isPending && !error && hasPendingGithubRepos ? (
              <div className="space-y-3">
                <ul className="w-full list-none space-y-2 p-0">
                  {hasConnectedGithubRepos
                    ? pendingConnectedGithubRepos.map((repo) => (
                        <li key={repo.id} className="ctx-repo-row group">
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
                        <li key={repo.gitUrl} className="ctx-repo-row group">
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
                  <Button
                    variant="outline"
                    className="mt-6 rounded-none"
                    onPress={handleConnectGithubFromEmptyState}
                    isDisabled={githubConnectBusy}
                    isPending={githubConnectBusy}
                  >
                    {installation ? "Select repositories" : "Connect GitHub"}
                  </Button>
                  <div className="mt-3">
                    <button
                      type="button"
                      className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
                      onClick={() =>
                        void navigate({
                          to: "/$orgSlug/connectors",
                          params: { orgSlug },
                        })
                      }
                    >
                      Open Connectors
                    </button>
                  </div>
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
                      onRetry={(selectedRepo) => {
                        setRetryingRepoId(selectedRepo.id)
                        retryMutation.mutate(selectedRepo.id)
                      }}
                      isRetrying={retryingRepoId === repo.id}
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
      {SelfHostedWizardModal}
    </AppShell>
  )
}
