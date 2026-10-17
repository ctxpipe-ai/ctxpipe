"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { githubSetupLinkOptions } from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { focusVisibleClassName } from "@/lib/focus-styles"

const primaryClassName = `${focusVisibleClassName} inline-flex h-11 items-center justify-center rounded-md border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50`

/**
 * The last slide for a user who created an organization. Onboarding is
 * already complete here, so a GitHub flow that leaves the page (to link a
 * GitHub account) cannot send the user back to onboarding. "Skip for now"
 * and "Continue" open Home, where the Get started guide has the next steps.
 */
export function OnboardingConnectGithubSlide(props: {
  orgSlug: string
  onDone: () => void
}) {
  const { orgSlug, onDone } = props
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const linkQuery = useQuery(githubSetupLinkOptions(orgSlug))
  const {
    start,
    isPending: flowPending,
    isSyncing,
    hasHostedApp,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => setConnected(true),
    onRegistered: () => {
      setConnected(true)
      setError(null)
    },
    onRegistrationFailed: setError,
    onWizardClosed: () => setError(null),
  })

  if (connected || linkQuery.data === "linked") {
    return (
      <>
        <h2 className="mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
          GitHub is connected
        </h2>
        <p className="mx-auto mb-12 max-w-xl text-balance text-zinc-300">
          Next, create your first Workspace on Home.
        </p>
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button type="button" className={primaryClassName} onClick={onDone}>
          Continue
        </button>
      </>
    )
  }

  const checking = linkQuery.isPending || hasHostedApp === null
  const selfHosted = hasHostedApp === false
  return (
    <>
      <h2 className="mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Connect GitHub
      </h2>
      <p className="mx-auto mb-3 max-w-xl text-balance text-zinc-300">
        {selfHosted
          ? "This deployment uses a GitHub App that your team creates. Register the app, then install it on the accounts that ctx| can read."
          : "ctx| keeps the knowledge of each Workspace in a GitHub repository and reads the code repositories that you link. You choose the repositories on GitHub."}
      </p>
      <output className="mx-auto mb-9 block min-h-5 text-xs text-zinc-400">
        {error ?? (isSyncing ? "Finishing the GitHub connection" : "")}
      </output>
      <div className="flex flex-col items-center gap-6">
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={checking || flowPending || isSyncing}
          className={primaryClassName}
          onClick={() => {
            setError(null)
            start("connect")
          }}
        >
          {selfHosted ? "Set up GitHub App" : "Connect GitHub"}
        </button>
        {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
        <button
          type="button"
          disabled={isSyncing}
          className={`${focusVisibleClassName} text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50`}
          onClick={onDone}
        >
          Skip for now
        </button>
        <p className="text-xs text-zinc-500">
          You can also connect GitHub later from Home.
        </p>
      </div>
      {SelfHostedWizardModal}
    </>
  )
}
