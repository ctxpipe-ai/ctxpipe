"use client"

import { useQuery } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"

type OnboardingGithubSlideProps = {
  orgSlug: string | null
  onContinue: () => void
}

export function OnboardingGithubSlide({
  orgSlug,
  onContinue,
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

  const hasGithubInstallation = Boolean(installation) || connectOptimistic

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
    onAlreadyInstalled: onContinueStable,
    onRegistered: () => {
      setConnectOptimistic(true)
      setGithubSetupError(null)
      onContinueStable()
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
    if (hasGithubInstallation) {
      return "GitHub is connected. Continue onboarding, or manage repository selection."
    }
    if (bootstrapStillLoading) {
      return "Connect your GitHub App to choose the organisation and repositories ctx| can index."
    }
    if (hasHostedApp) {
      return "Connect your GitHub App to choose the organisation and repositories ctx| can index."
    }
    return "This deployment uses a GitHub App you create in your organisation. You will register the app, webhook URL, and credentials, then install it on the accounts you want ctx| to index."
  })()

  const primaryLabel = hasGithubInstallation
    ? "Continue"
    : bootstrapStillLoading
      ? "Connect GitHub"
      : hasHostedApp
        ? "Connect GitHub"
        : "Set up GitHub App"

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
              if (hasGithubInstallation) {
                onContinueStable()
                return
              }
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
          {hasGithubInstallation ? (
            <button
              type="button"
              disabled={isGithubSyncing}
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() =>
                orgSlug &&
                window.location.assign(`/${orgSlug}/repositories/github/setup`)
              }
            >
              Manage repositories
            </button>
          ) : (
            <button
              type="button"
              disabled={isGithubSyncing}
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onContinueStable()}
            >
              I&apos;ll do this later
            </button>
          )}
        </div>
      </div>
      {flowEnabled ? SelfHostedWizardModal : null}
    </>
  )
}
