import HyperDX from "@hyperdx/browser"
import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
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
  /** Repositories are already queued or indexed, so it does not start again. */
  alreadyIndexed: boolean
  /** Full names of what was queued, so the picture fills before indexing rows exist. */
  onRepositoriesQueued: (repositories: string[]) => void
  onContinue: () => void
  onBack: () => void
  onSkip: () => void
}

type ContextRepository = {
  full_name: string
  name: string
  clone_url: string
  default_branch: string
}

export function OnboardingGithubStep({
  orgSlug,
  hasInstallation,
  alreadyIndexed,
  onRepositoriesQueued,
  onContinue,
  onBack,
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

  // Same key as GitHubRepositorySetupForm, so Change reuses it.
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

  // What is saved now: GitHub's grant after auto-indexing, or their edit.
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
    enabled: installed,
  })

  const patchInstallation = async (json: Record<string, unknown>) => {
    const res = await (
      client[":orgSlug"].api.v1.github.installation.$patch as (arg: {
        param: { orgSlug: string }
        json: Record<string, unknown>
      }) => Promise<Response>
    )({ param: { orgSlug }, json })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error ?? "Failed to save")
    }
  }

  // Index exactly what GitHub was given as soon as we know it: "all" keeps
  // following new repositories, a selection indexes every granted one.
  const autoIndex = useMutation({
    mutationFn: () =>
      patchInstallation({
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
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["repositories", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: ["github-installation-setup", orgSlug],
      })
      HyperDX.addAction("repository_index_started")
      onRepositoriesQueued(grantedRepos.map((repo) => repo.full_name))
    },
  })

  // Starting indexing is the side effect of GitHub's list arriving, not of a
  // click, so it runs once from here.
  const canAutoIndex =
    installed &&
    granted.isSuccess &&
    grantedRepos.length > 0 &&
    !alreadyIndexed &&
    !editing &&
    autoIndex.isIdle
  const startAutoIndex = autoIndex.mutate
  useEffect(() => {
    if (canAutoIndex) startAutoIndex()
  }, [canAutoIndex, startAutoIndex])

  // Continue keeps the saved selection and adds the context repository. The
  // backend only queues repositories it has not seen, so this does not
  // index anything twice.
  const continueStep = useMutation({
    mutationFn: async (repository: ContextRepository) => {
      const selection = setupData?.ingestAllRepositories
        ? {
            ingestAllRepositories: true,
            includeFutureRepos: setupData.includeFutureRepos,
          }
        : {
            ingestAllRepositories: false,
            includeFutureRepos: false,
            selectedRepositories: (setupData?.savedRepositories ?? []).map(
              (repo) => ({
                full_name: repo.name,
                name: repo.name.split("/").pop() ?? repo.name,
                clone_url: repo.gitUrl,
              }),
            ),
          }
      await patchInstallation({ ...selection, contextRepository: repository })
    },
    onSuccess: onContinue,
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
          setEditing(false)
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
    const repoWord = count === 1 ? "repository" : "repositories"

    if (granted.isError || count === 0) {
      return (
        <>
          <p
            role={granted.isError ? "alert" : undefined}
            className={`m-0 text-sm ${granted.isError ? "text-red-300" : "text-muted-foreground"}`}
          >
            {granted.isError
              ? "Could not load repositories from GitHub. Change the selection to try again."
              : "GitHub has not given ctx| access to any repositories yet. Change the selection to grant access."}
          </p>
          <div className="flex flex-wrap items-center gap-6 pt-2">
            <Button
              variant="primary"
              className="rounded-none"
              onPress={() => setEditing(true)}
            >
              Change selection
            </Button>
            <Button variant="quiet" className="rounded-none" onPress={onBack}>
              Back
            </Button>
          </div>
        </>
      )
    }

    // One primary action (Continue). Indexing runs on its own; changing the
    // selection and choosing the context repository sit beside what they
    // change.
    return (
      <>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="ctx-label m-0">Repositories</h3>
            <Button
              variant="quiet"
              className="h-auto rounded-none px-0 text-sm"
              isDisabled={autoIndex.isPending}
              onPress={() => setEditing(true)}
            >
              Change
            </Button>
          </div>
          {autoIndex.isError ? (
            <p role="alert" className="m-0 text-sm text-red-300">
              {autoIndex.error.message}{" "}
              <Button
                variant="quiet"
                className="h-auto rounded-none px-0 text-sm"
                onPress={() => autoIndex.mutate()}
              >
                Try again
              </Button>
            </p>
          ) : (
            <p className="m-0 inline-flex items-center gap-2 text-sm text-muted-foreground">
              <span className="ctx-indexing-dot" aria-hidden />
              {grantsAll
                ? `Indexing all ${count} ${repoWord} you shared in GitHub, and any you add later.`
                : `Indexing the ${count} ${repoWord} you shared in GitHub.`}
            </p>
          )}
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
          <h3 className="ctx-label m-0">Context repository</h3>
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
                        <IconExternalLink className="size-3.5" aria-hidden />
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
                  Where ctx| keeps pull-request capture and connector content.{" "}
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
                  <ComboBoxItem id={String(repo.id)} textValue={repo.full_name}>
                    {repo.full_name}
                  </ComboBoxItem>
                )}
              </ComboBox>
            </>
          )}
        </section>

        {continueStep.error ? (
          <p role="alert" className="m-0 text-sm text-red-300">
            {continueStep.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-6 pt-2">
          <Button
            variant="primary"
            className="rounded-none"
            isPending={continueStep.isPending}
            isDisabled={autoIndex.isPending}
            onPress={() =>
              contextRepo
                ? continueStep.mutate({
                    full_name: contextRepo.full_name,
                    name: contextRepo.name,
                    clone_url: contextRepo.clone_url,
                    default_branch: contextRepo.default_branch ?? "main",
                  })
                : onContinue()
            }
          >
            Continue
          </Button>
          <Button variant="quiet" className="rounded-none" onPress={onBack}>
            Back
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
      <div className="flex flex-wrap items-center gap-6">
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
        <Button variant="quiet" className="rounded-none" onPress={onBack}>
          Back
        </Button>
      </div>
      {SelfHostedWizardModal}
    </>
  )
}
