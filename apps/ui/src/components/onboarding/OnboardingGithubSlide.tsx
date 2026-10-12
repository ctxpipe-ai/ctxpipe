"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import { githubSetupLinkOptions } from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { focusVisibleClassName } from "@/lib/focus-styles"

type OnboardingGithubSlideProps = {
  orgSlug: string | null
  /** Skip for now, or Continue after GitHub is connected. Finishes onboarding. */
  onFinish: () => void
  finishing?: boolean
}

const primaryClassName =
  "inline-flex h-11 items-center justify-center rounded-md border border-border px-6 text-sm font-medium transition-colors"

export function OnboardingGithubSlide({
  orgSlug,
  onFinish,
  finishing,
}: OnboardingGithubSlideProps) {
  const [githubSetupError, setGithubSetupError] = useState<string | null>(null)
  const [connectOptimistic, setConnectOptimistic] = useState(false)

  const linkQuery = useQuery({
    ...githubSetupLinkOptions(orgSlug ?? ""),
    enabled: !!orgSlug,
  })
  const linked = linkQuery.data === "linked" || connectOptimistic

  const {
    start,
    isPending: flowPending,
    isSyncing,
    hasHostedApp,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug: orgSlug ?? "",
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

  if (linked && orgSlug) {
    return (
      <>
        <h2 className="mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
          GitHub is connected
        </h2>
        <p className="mx-auto mb-12 max-w-xl text-balance text-zinc-300">
          Next, create your first Workspace on Home.
        </p>
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={finishing}
          className={`${focusVisibleClassName} ${primaryClassName} bg-zinc-100 text-zinc-950 hover:bg-zinc-200 disabled:opacity-50`}
          onClick={() => onFinish()}
        >
          Continue
        </button>
      </>
    )
  }

  const bootstrapStillLoading = hasHostedApp === null
  const checking = !orgSlug || linkQuery.isPending || bootstrapStillLoading
  const primaryBusy = checking || flowPending || isSyncing
  const selfHosted = hasHostedApp === false

  return (
    <>
      <h2 className="mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Connect GitHub
      </h2>
      <p className="mx-auto mb-3 max-w-xl text-balance text-zinc-300">
        {isSyncing
          ? "Finalizing your GitHub connection..."
          : selfHosted
            ? "This deployment uses a GitHub App you create in your organization. You will register the app, webhook URL, and credentials, then install it on the accounts you want ctx| to access."
            : "ctx| reads the code you choose and writes to one knowledge repository. You pick the repositories on GitHub."}
      </p>
      <p className="mx-auto mb-9 min-h-5 text-xs text-zinc-400">
        {githubSetupError ? githubSetupError : " "}
      </p>
      <div className="flex flex-col items-center gap-6">
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={primaryBusy}
          className={`${focusVisibleClassName} ${primaryClassName} ${
            primaryBusy
              ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700"
              : "bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
          }`}
          onClick={() => {
            if (!orgSlug) return
            setGithubSetupError(null)
            start("connect")
          }}
        >
          {isSyncing
            ? "Finalizing connection..."
            : checking
              ? "Checking..."
              : selfHosted
                ? "Set up GitHub App"
                : "Connect GitHub"}
        </button>
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={isSyncing || finishing}
          className={`${focusVisibleClassName} text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50`}
          onClick={() => onFinish()}
        >
          Skip for now
        </button>
      </div>
      {orgSlug ? SelfHostedWizardModal : null}
    </>
  )
}
