import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { GITHUB_FINALISING_MIN_MS } from "@/components/onboarding/constants"
import { Button } from "@/components/ui/Button"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import {
  type GitHubRepositorySetupData,
  GitHubRepositorySetupForm,
} from "@/features/repositories"
import { client } from "@/lib/api"

type OnboardingGithubStepProps = {
  orgSlug: string
  hasInstallation: boolean
  onRepositoriesQueued: () => void
  onSkip: () => void
}

export function OnboardingGithubStep({
  orgSlug,
  hasInstallation,
  onRepositoriesQueued,
  onSkip,
}: OnboardingGithubStepProps) {
  const [setupError, setSetupError] = useState<string | null>(null)
  const [connectOptimistic, setConnectOptimistic] = useState(false)
  const installed = hasInstallation || connectOptimistic

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

  if (installed) {
    if (setupPending) {
      return (
        <p className="m-0 text-sm text-muted-foreground">
          Loading repositories from GitHub…
        </p>
      )
    }
    return (
      <GitHubRepositorySetupForm
        orgSlug={orgSlug}
        setupData={setupData}
        variant="step"
        onSaveSuccess={onRepositoriesQueued}
        onCancel={onSkip}
      />
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
            : "Choose which repositories ctx| reads. Nothing is indexed until you pick them."}
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
