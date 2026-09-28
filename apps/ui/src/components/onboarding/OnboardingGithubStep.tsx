import HyperDX from "@hyperdx/browser"
import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { getConnectorContextRepositoryCreateUrl } from "@/features/connectors/components/ConnectorContextRepositoryGuidance"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  type GitHubRepositorySetupData,
  GitHubRepositorySetupForm,
} from "@/features/repositories"
import { fetchInstallationReposPage } from "@/features/repositories/components/GitHubRepositorySetupForm"
import {
  collectInstallationRepoPages,
  type GithubRepoItem,
  sortGithubRepos,
  suggestedContextRepository,
} from "@/features/repositories/githubRepoSelection"
import { client } from "@/lib/api"
import { githubGrantAccessUrls } from "@/lib/github-app-url"

type OnboardingGithubStepProps = {
  orgSlug: string
  hasInstallation: boolean
  /** Full names of what was queued, so the picture fills before indexing rows exist. */
  onRepositoriesQueued: (repositories: string[]) => void
  onSkip: () => void
}

export function OnboardingGithubStep({
  orgSlug,
  hasInstallation,
  onRepositoriesQueued,
  onSkip,
}: OnboardingGithubStepProps) {
  const queryClient = useQueryClient()
  const [setupError, setSetupError] = useState<string | null>(null)
  const [connectOptimistic, setConnectOptimistic] = useState(false)
  const [editing, setEditing] = useState(false)
  // Repository ids GitHub shared when they went to create a context
  // repository; the first new one is theirs, whatever they named it.
  const [knownRepoIds, setKnownRepoIds] = useState<Set<number> | null>(null)
  // undefined: pick automatically. null: none. A number: their choice.
  const [pickedContextId, setPickedContextId] = useState<
    number | null | undefined
  >(undefined)
  const pickContextRepo = (repos: readonly GithubRepoItem[]) =>
    pickedContextId === undefined
      ? (suggestedContextRepository(repos) ??
        (knownRepoIds
          ? repos.find((repo) => !knownRepoIds.has(repo.id))
          : undefined) ??
        null)
      : (repos.find((repo) => repo.id === pickedContextId) ?? null)
  const installed = hasInstallation || connectOptimistic

  const { data: installation } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
    enabled: installed,
  })

  // Same key as GitHubRepositorySetupForm, so "Change selection" reuses it.
  const granted = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: () =>
      collectInstallationRepoPages((page) =>
        fetchInstallationReposPage(orgSlug, page),
      ),
    enabled: installed,
    refetchInterval: (query) =>
      knownRepoIds && !pickContextRepo(query.state.data?.repositories ?? [])
        ? 4000
        : false,
    refetchOnWindowFocus: knownRepoIds ? "always" : true,
  })
  const grantedRepos = granted.data?.repositories ?? []
  const grantsAll = granted.data?.repositorySelection === "all"
  const contextRepo = pickContextRepo(grantedRepos)

  const { data: setupData, isPending: setupPending } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch GitHub setup data")
      return (await res.json()) as GitHubRepositorySetupData
    },
    enabled: installed && editing,
  })

  // Index exactly what GitHub was given: "all" keeps following new
  // repositories, a selection indexes every granted repository.
  const indexGranted = useMutation({
    mutationFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.$patch as (arg: {
          param: { orgSlug: string }
          json: Record<string, unknown>
        }) => Promise<Response>
      )({
        param: { orgSlug },
        json: {
          ingestAllRepositories: grantsAll,
          includeFutureRepos: grantsAll,
          ...(grantsAll
            ? {}
            : {
                selectedRepositories: grantedRepos.map((repo) => ({
                  id: repo.id,
                  full_name: repo.full_name,
                  name: repo.name,
                  clone_url: repo.clone_url,
                })),
              }),
          ...(contextRepo
            ? {
                contextRepository: {
                  full_name: contextRepo.full_name,
                  name: contextRepo.name,
                  clone_url: contextRepo.clone_url,
                  default_branch: contextRepo.default_branch ?? "main",
                },
              }
            : {}),
        },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? "Failed to save")
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["repositories", orgSlug],
      })
      HyperDX.addAction("repository_index_started")
      onRepositoriesQueued(grantedRepos.map((repo) => repo.full_name))
    },
  })

  const { start, isPending, isSyncing, hasHostedApp, SelfHostedWizardModal } =
    useGithubConnectFlow({
      orgSlug,
      minFinalizeAfterRegistrationMs: GITHUB_FINALISING_MIN_MS,
      onAlreadyInstalled: () => setConnectOptimistic(true),
      onRegistered: () => {
        setConnectOptimistic(true)
        setSetupError(null)
      },
      onRegistrationFailed: (message) => setSetupError(message),
      onWizardClosed: () => setSetupError(null),
    })

  if (installed && editing) {
    if (setupPending) {
      return (
        <p className="m-0 text-sm text-muted-foreground">
          Loading your saved selection…
        </p>
      )
    }
    return (
      <GitHubRepositorySetupForm
        orgSlug={orgSlug}
        setupData={setupData}
        variant="step"
        onSaveSuccess={() => {
          const saved = queryClient.getQueryData<GitHubRepositorySetupData>([
            "github-installation-setup",
            orgSlug,
          ])
          onRepositoriesQueued(
            saved?.ingestAllRepositories
              ? grantedRepos.map((repo) => repo.full_name)
              : (saved?.savedRepositories.map((repo) => repo.name) ?? []),
          )
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  if (installed) {
    if (granted.isPending) {
      return (
        <p className="m-0 text-sm text-muted-foreground">
          Loading repositories from GitHub…
        </p>
      )
    }
    const count = grantedRepos.length
    const shown = grantedRepos.slice(0, 5)
    const canIndex = count > 0 && !granted.isError
    const repoWord = count === 1 ? "repository" : "repositories"
    // One primary action (Index). Changing the selection and the optional
    // context repository sit beside what they change, as quiet links.
    return (
      <>
        {granted.isError ? (
          <p role="alert" className="m-0 text-sm text-red-300">
            Could not load repositories from GitHub. Change the selection to try
            again.
          </p>
        ) : count === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            GitHub has not given ctx| access to any repositories yet. Change the
            selection to grant access.
          </p>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="ctx-label m-0">Repositories</h3>
                <Button
                  variant="quiet"
                  className="h-auto rounded-none px-0 text-sm"
                  isDisabled={indexGranted.isPending}
                  onPress={() => setEditing(true)}
                >
                  Change
                </Button>
              </div>
              <p className="m-0 text-sm text-muted-foreground">
                {grantsAll
                  ? `All ${count} ${repoWord} you shared in GitHub, and any you add later.`
                  : `The ${count} ${repoWord} you shared in GitHub.`}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {shown.map((repo) => (
                  <li
                    key={repo.id}
                    className="truncate font-mono text-xs text-zinc-300"
                  >
                    {repo.full_name}
                  </li>
                ))}
                {count > shown.length ? (
                  <li className="font-mono text-xs text-zinc-500">
                    +{count - shown.length} more
                  </li>
                ) : null}
              </ul>
            </section>
            <section className="flex flex-col gap-2 border-t border-white/5 pt-4">
              <h3 className="ctx-label m-0">
                Context repository{" "}
                <span className="normal-case tracking-normal">· optional</span>
              </h3>
              {contextRepo ? (
                <div className="flex items-center justify-between gap-3">
                  <code className="truncate font-mono text-xs text-zinc-300">
                    {contextRepo.full_name}
                  </code>
                  <Button
                    variant="quiet"
                    className="h-auto rounded-none px-0 text-sm"
                    onPress={() => {
                      setPickedContextId(null)
                      setKnownRepoIds(null)
                    }}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  {knownRepoIds ? (
                    <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-muted-foreground">
                      <li>1. Create it in GitHub. Any name works.</li>
                      {grantsAll ? null : (
                        <li>
                          2.{" "}
                          <a
                            href={
                              githubGrantAccessUrls({
                                appSlug: installation?.appSlug,
                                manageUrl: granted.data?.manageUrl,
                              })[0]
                            }
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
                          >
                            Share it with ctx|
                            <IconExternalLink
                              className="size-3.5"
                              aria-hidden
                            />
                          </a>{" "}
                          in GitHub.
                        </li>
                      )}
                      <li>
                        <output className="inline-flex items-center gap-2 text-zinc-200">
                          <span className="ctx-indexing-dot" aria-hidden />
                          Watching for the new repository
                        </output>
                      </li>
                    </ol>
                  ) : (
                    <p className="m-0 text-sm text-muted-foreground">
                      One repository for pull-request capture and connector
                      content.{" "}
                      <a
                        href={getConnectorContextRepositoryCreateUrl(
                          installation?.accountSlug,
                        )}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => {
                          setPickedContextId(undefined)
                          setKnownRepoIds(
                            new Set(grantedRepos.map((repo) => repo.id)),
                          )
                        }}
                        className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
                      >
                        Create one on GitHub
                        <IconExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </p>
                  )}
                  <ComboBox
                    label="Or use a repository you already shared"
                    placeholder="Search repositories"
                    selectedKey={null}
                    items={sortGithubRepos(grantedRepos, "name-asc")}
                    onSelectionChange={(key) => {
                      if (key == null || key === "") return
                      setPickedContextId(Number(key))
                      setKnownRepoIds(null)
                    }}
                  >
                    {(repo) => (
                      <ComboBoxItem
                        id={String(repo.id)}
                        textValue={repo.full_name}
                      >
                        {repo.full_name}
                      </ComboBoxItem>
                    )}
                  </ComboBox>
                </>
              )}
            </section>
          </>
        )}
        {indexGranted.error ? (
          <p role="alert" className="m-0 text-sm text-red-300">
            {indexGranted.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-6 pt-2">
          {canIndex ? (
            <Button
              variant="primary"
              className="rounded-none"
              isPending={indexGranted.isPending}
              onPress={() => indexGranted.mutate()}
            >
              {`Index ${count} ${repoWord}`}
            </Button>
          ) : (
            <Button
              variant="primary"
              className="rounded-none"
              onPress={() => setEditing(true)}
            >
              Change selection
            </Button>
          )}
          <Button
            variant="ghost"
            className="rounded-none"
            isDisabled={indexGranted.isPending}
            onPress={onSkip}
          >
            I’ll do this later
          </Button>
        </div>
      </>
    )
  }

  const selfHosted = hasHostedApp === false
  const busy = isPending || isSyncing || hasHostedApp === null

  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">
        {isSyncing
          ? "Finishing the GitHub connection."
          : selfHosted
            ? "This deployment uses a GitHub App you register yourself. You set its webhook URL and credentials, then install it on the accounts ctx| should read."
            : "Choose which repositories ctx| reads in GitHub. ctx| indexes that selection."}
      </p>
      {setupError ? (
        <p role="alert" className="m-0 text-sm text-red-300">
          {setupError}
        </p>
      ) : null}
      <div className="flex items-center gap-6">
        <Button
          variant="primary"
          className="rounded-none"
          isDisabled={busy}
          onPress={() => {
            setSetupError(null)
            start("connect")
          }}
        >
          {isSyncing
            ? "Connecting…"
            : selfHosted
              ? "Set up GitHub App"
              : "Connect GitHub"}
        </Button>
        <Button
          variant="ghost"
          className="rounded-none"
          isDisabled={isSyncing}
          onPress={onSkip}
        >
          I’ll do this later
        </Button>
      </div>
      {SelfHostedWizardModal}
    </>
  )
}
