"use client"

import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"

type GitHubPrerequisiteStepProps = {
  orgSlug: string
  sourceName: "Confluence" | "Notion"
  onConnected?: () => void | Promise<void>
}

export function GitHubPrerequisiteStep({
  orgSlug,
  sourceName,
  onConnected,
}: GitHubPrerequisiteStepProps) {
  const navigate = useNavigate()
  const { start, isPending, isSyncing, SelfHostedWizardModal } =
    useGithubConnectFlow({
      orgSlug,
      onAlreadyInstalled: () => void onConnected?.(),
      onRegistered: () => void onConnected?.(),
    })

  return (
    <>
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium text-foreground">
            Connect GitHub
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {sourceName} content is mirrored into a GitHub repository, then
            managed through the same config PR flow.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            className="rounded-none"
            isPending={isPending || isSyncing}
            onPress={() => start("connect")}
          >
            Connect GitHub
          </Button>
          <button
            type="button"
            className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
            onClick={() => {
              void navigate({
                to: "/$orgSlug/repositories",
                params: { orgSlug },
              })
            }}
          >
            Open repositories
          </button>
        </div>
      </div>
      {SelfHostedWizardModal}
    </>
  )
}
