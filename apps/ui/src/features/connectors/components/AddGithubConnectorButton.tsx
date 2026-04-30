"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { client } from "@/lib/api"
import {
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"
import { GithubSelfHostedWizardModal } from "./GithubSelfHostedWizardModal"

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
  const watchPopupClose = useWatchPopupClose()
  const [installStarting, setInstallStarting] = useState(false)
  const [selfHostedWizardOpen, setSelfHostedWizardOpen] = useState(false)

  const { data: bootstrap, isPending: bootstrapPending } =
    useGithubConnectorBootstrap(orgSlug)

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
    if (bootstrapPending) {
      return
    }
    const hostedUrl = bootstrap?.hostedDefaultAppInstallUrl ?? null
    if (hostedUrl) {
      try {
        localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
      } catch {
        // ignore
      }
      setGithubSetupOrgHint(orgSlug)
      setInstallStarting(true)
      const popup = openCenteredPopup(hostedUrl, {
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
      return
    }
    setSelfHostedWizardOpen(true)
  }

  const busy =
    installationPending || installStarting || bootstrapPending

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
        onClick={handleClick}
      >
        <span className="ctx-node size-12 transition-colors group-hover:border-teal-400/60 group-hover:bg-teal-400/5">
          <IconBrandGithub className="size-5 text-foreground" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-medium text-foreground">
            GitHub
            {busy ? (
              <Spinner className="size-4 text-muted-foreground" aria-hidden />
            ) : null}
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">
            Connect the GitHub App, then choose which repositories ctx| ingests
            for this organisation.
          </span>
        </span>
      </button>
      <GithubSelfHostedWizardModal
        orgSlug={orgSlug}
        bootstrap={bootstrap ?? undefined}
        isOpen={selfHostedWizardOpen}
        onOpenChange={setSelfHostedWizardOpen}
        onInstallFlowStarted={onFlowStarted}
      />
    </>
  )
}
