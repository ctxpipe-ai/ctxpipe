import HyperDX from "@hyperdx/browser"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import { Button } from "@/components/ui/Button"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  type GitHubRepositorySetupData,
  GitHubRepositorySetupForm,
} from "@/features/repositories"
import { fetchInstallationReposPage } from "@/features/repositories/components/GitHubRepositorySetupForm"
import {
  collectInstallationRepoPages,
  suggestedContextRepository,
} from "@/features/repositories/githubRepoSelection"
import { client } from "@/lib/api"

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
  const installed = hasInstallation || connectOptimistic

  // Same key as GitHubRepositorySetupForm, so "Change selection" reuses it.
  const granted = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: () =>
      collectInstallationRepoPages((page) =>
        fetchInstallationReposPage(orgSlug, page),
      ),
    enabled: installed,
  })
  const grantedRepos = granted.data?.repositories ?? []
  const grantsAll = granted.data?.repositorySelection === "all"
  const contextRepo = suggestedContextRepository(grantedRepos) ?? null

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
            <p className="m-0 text-sm text-muted-foreground">
              {grantsAll
                ? `You gave ctx| access to all ${count} repositories in GitHub. It indexes them and any you add later.`
                : `You gave ctx| access to ${count} ${count === 1 ? "repository" : "repositories"} in GitHub. It indexes ${count === 1 ? "it" : "them"}.`}
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
            {contextRepo ? (
              <p className="m-0 text-sm text-muted-foreground">
                Context repository:{" "}
                <code className="font-mono text-zinc-200">
                  {contextRepo.full_name}
                </code>
              </p>
            ) : null}
          </>
        )}
        {indexGranted.error ? (
          <p role="alert" className="m-0 text-sm text-red-300">
            {indexGranted.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {count > 0 && !granted.isError ? (
            <Button
              variant="primary"
              className="rounded-none"
              isPending={indexGranted.isPending}
              onPress={() => indexGranted.mutate()}
            >
              {`Index ${count} ${count === 1 ? "repository" : "repositories"}`}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="rounded-none"
            isDisabled={indexGranted.isPending}
            onPress={() => setEditing(true)}
          >
            Change selection
          </Button>
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
