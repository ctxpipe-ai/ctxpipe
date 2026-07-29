"use client"

import { useQuery } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  type GitHubRepositorySetupData,
  GitHubRepositorySetupForm,
} from "@/features/repositories"
import { client } from "@/lib/api"

type OnboardingGithubSlideProps = {
  orgSlug: string | null
  onContinue: () => void
  onRepositoriesQueued?: () => void
}

export function OnboardingGithubSlide({
  orgSlug,
  onContinue,
  onRepositoriesQueued,
}: OnboardingGithubSlideProps) {
  const [githubSetupError, setGithubSetupError] = useState<string | null>(null)
  const [connectOptimistic, setConnectOptimistic] = useState(false)

  const onContinueStable = useCallback(() => {
    onContinue()
  }, [onContinue])
  const handleRepositoriesSaved = useCallback(() => {
    onRepositoriesQueued?.()
    onContinue()
  }, [onContinue, onRepositoriesQueued])

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug ?? ""),
    queryFn: () =>
      orgSlug ? fetchGithubInstallationSummary(orgSlug) : Promise.resolve(null),
    enabled: !!orgSlug,
  })

  const hasGithubInstallation = Boolean(installation) || connectOptimistic

  const { data: setupData, isPending: setupPending } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      if (!orgSlug) throw new Error("Missing organisation")
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch GitHub setup data")
      return (await res.json()) as GitHubRepositorySetupData
    },
    enabled: Boolean(orgSlug && hasGithubInstallation),
  })

  const hookOrg = orgSlug ?? ""
  const flowEnabled = !!orgSlug

  const {
    start,
    isPending: flowPending,
    isSyncing,
    hasHostedApp,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug: hookOrg,
    minFinalizeAfterRegistrationMs: GITHUB_FINALISING_MIN_MS,
    onAlreadyInstalled: () => setConnectOptimistic(true),
    onRegistered: () => {
      setConnectOptimistic(true)
      setGithubSetupError(null)
    },
    onRegistrationFailed: (msg) => {
      setGithubSetupError(msg)
    },
    onWizardClosed: () => {
      setGithubSetupError(null)
    },
  })

  const bootstrapStillLoading = hasHostedApp === null
  const primaryBusy =
    !flowEnabled ||
    installationPending ||
    flowPending ||
    isSyncing ||
    bootstrapStillLoading

  const isGithubSyncing = isSyncing

  const hostedDescription = (() => {
    if (bootstrapStillLoading) {
      return "Connect your GitHub App to choose the organisation and repositories ctx| can index."
    }
    if (hasHostedApp) {
      return "Connect your GitHub App to choose the organisation and repositories ctx| can index."
    }
    return "This deployment uses a GitHub App you create in your organisation. You will register the app, webhook URL, and credentials, then install it on the accounts you want ctx| to index."
  })()

  const primaryLabel = bootstrapStillLoading
    ? "Connect GitHub"
    : hasHostedApp
      ? "Connect GitHub"
      : "Set up GitHub App"

  if (hasGithubInstallation) {
    if (setupPending) {
      return (
        <>
          <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
            Choose repositories to index
          </h2>
          <div className="onb-in-2 mx-auto flex min-h-[280px] max-w-3xl items-center justify-center">
            <p className="text-sm text-zinc-400">
              Loading repositories from GitHub…
            </p>
          </div>
        </>
      )
    }

    return (
      <div className="onb-in-2 mx-auto w-full max-w-3xl">
        <GitHubRepositorySetupForm
          orgSlug={hookOrg}
          setupData={setupData}
          variant="onboarding"
          onSaveSuccess={handleRepositoriesSaved}
          onCancel={onContinueStable}
        />
      </div>
    )
  }

  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Connect GitHub
      </h2>
      <div className="onb-in-2 mx-auto mb-14 flex min-h-[280px] max-w-3xl flex-col">
        <p className="mx-auto mb-3 text-balance text-zinc-300">
          {isGithubSyncing
            ? "Finalising your GitHub connection..."
            : hostedDescription}
        </p>
        <p className="mx-auto min-h-5 text-xs text-zinc-400">
          {githubSetupError ? githubSetupError : "\u00A0"}
        </p>
        <div className="mt-auto flex flex-col items-center gap-8">
          <button
            type="button"
            disabled={
              primaryBusy ||
              (!orgSlug && !hasGithubInstallation) ||
              !flowEnabled
            }
            className={`inline-flex h-11 items-center justify-center rounded-none border border-border px-6 text-sm font-medium transition-colors ${
              primaryBusy || (!orgSlug && !hasGithubInstallation)
                ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700"
                : "bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
            }`}
            onClick={() => {
              if (!orgSlug) return
              setGithubSetupError(null)
              start("connect")
            }}
          >
            {isGithubSyncing
              ? "Finalising connection..."
              : installationPending || bootstrapStillLoading
                ? "Checking..."
                : primaryLabel}
          </button>
          <button
            type="button"
            disabled={isGithubSyncing}
            className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onContinueStable()}
          >
            I&apos;ll do this later
          </button>
        </div>
      </div>
      {flowEnabled ? SelfHostedWizardModal : null}
    </>
  )
}
