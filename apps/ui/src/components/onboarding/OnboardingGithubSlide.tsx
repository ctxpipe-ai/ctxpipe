"use client"

import { useQuery } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
  githubInstallationIsLinked,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { GithubWorkspaceDestinationFromApi } from "@/features/workspaces/GithubWorkspaceDestination"
import type { Workspace } from "@/features/workspaces/types"

type OnboardingGithubSlideProps = {
  orgSlug: string | null
  onContinue: () => void
  onCreateWorkspace?: () => void
  onSelectWorkspace?: (workspace: Workspace) => void
}

export function OnboardingGithubSlide({
  orgSlug,
  onContinue,
  onCreateWorkspace,
  onSelectWorkspace,
}: OnboardingGithubSlideProps) {
  const [githubSetupError, setGithubSetupError] = useState<string | null>(null)
  const [connectOptimistic, setConnectOptimistic] = useState(false)

  const onContinueStable = useCallback(() => {
    onContinue()
  }, [onContinue])

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug ?? ""),
    queryFn: () =>
      orgSlug ? fetchGithubInstallationSummary(orgSlug) : Promise.resolve(null),
    enabled: !!orgSlug,
  })

  const hasGithubInstallation =
    githubInstallationIsLinked(installation) || connectOptimistic

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
      return "Connect your GitHub App to choose the organization and repositories ctx| can access."
    }
    if (hasHostedApp) {
      return "Connect your GitHub App to choose the organization and repositories ctx| can access."
    }
    return "This deployment uses a GitHub App you create in your organization. You will register the app, webhook URL, and credentials, then install it on the accounts you want ctx| to access."
  })()

  const primaryLabel = bootstrapStillLoading
    ? "Connect GitHub"
    : hasHostedApp
      ? "Connect GitHub"
      : "Set up GitHub App"

  if (hasGithubInstallation && orgSlug) {
    return (
      <div className="onb-in-2 mx-auto w-full max-w-3xl">
        <GithubWorkspaceDestinationFromApi
          orgSlug={orgSlug}
          variant="onboarding"
          onCreateWorkspace={() => {
            if (onCreateWorkspace) {
              onCreateWorkspace()
              return
            }
            onContinueStable()
          }}
          onSelectWorkspace={(workspace) => {
            if (onSelectWorkspace) {
              onSelectWorkspace(workspace)
              return
            }
            onContinueStable()
          }}
          onClose={onContinueStable}
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
            ? "Finalizing your GitHub connection..."
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
              ? "Finalizing connection..."
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
