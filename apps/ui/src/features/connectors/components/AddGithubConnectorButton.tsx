"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { client } from "@/lib/api"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

export type AddGithubConnectorButtonProps = {
  orgSlug: string
  /** Called when a navigation or install flow has started (e.g. close the catalog). */
  onFlowStarted?: () => void
}

export function AddGithubConnectorButton({
  orgSlug,
  onFlowStarted,
}: AddGithubConnectorButtonProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const watchPopupClose = useWatchPopupClose()
  const [installStarting, setInstallStarting] = useState(false)

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: ["github-installation", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.github.installation.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to check GitHub installation")
      return (await res.json()) as { id: string } | null
    },
  })

  const goToSharedSetup = useCallback(() => {
    navigate({
      to: "/$orgSlug/repositories/github/setup",
      params: { orgSlug },
      search: { returnTo: "connectors" },
    })
  }, [navigate, orgSlug])

  const handleClick = () => {
    onFlowStarted?.()
    if (installation) {
      goToSharedSetup()
      return
    }
    setGithubSetupOrgHint(orgSlug)
    setInstallStarting(true)
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: GITHUB_POPUP_NAME,
      width: 1120,
      height: 780,
    })
    if (!popup) {
      setInstallStarting(false)
      return
    }

    watchPopupClose(popup, () => {
      setInstallStarting(false)
      void (async () => {
        const { status } = await handleGithubSetupPopupResult(
          orgSlug,
          queryClient,
        )
        if (status === "registered") {
          goToSharedSetup()
        }
      })()
    })
  }

  const busy = installationPending || installStarting

  return (
    <button
      type="button"
      disabled={busy}
      className="flex w-full items-start gap-4 rounded-none border border-zinc-800 bg-zinc-900/40 p-4 text-left outline-none transition hover:border-zinc-700 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
      onClick={handleClick}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-950">
        <IconBrandGithub className="size-8 text-zinc-100" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium text-zinc-100">
          GitHub
          {busy ? (
            <Spinner className="size-4 text-zinc-400" aria-hidden />
          ) : null}
        </span>
        <span className="mt-1 block text-sm text-zinc-400">
          Connect the GitHub App, then choose which repositories ctx| ingests
          for this organization.
        </span>
      </span>
    </button>
  )
}
