"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

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
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const watchPopupClose = useWatchPopupClose()
  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const [githubConnectStarting, setGithubConnectStarting] = useState(false)

  const handleConnectGithub = () => {
    setGithubSetupOrgHint(orgSlug)
    setGithubConnectStarting(true)
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: GITHUB_POPUP_NAME,
      width: 1120,
      height: 780,
    })
    if (!popup) {
      setGithubConnectStarting(false)
      return
    }

    watchPopupClose(popup, () => {
      setGithubConnectStarting(false)
      void (async () => {
        const { status } = await handleGithubSetupPopupResult(
          orgSlug,
          queryClient,
        )
        if (status === "registered") await onConnected?.()
      })()
    })
  }

  return (
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
          isPending={githubConnectStarting}
          onPress={handleConnectGithub}
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
  )
}
