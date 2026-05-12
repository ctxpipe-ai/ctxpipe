"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import { Spinner } from "@/components/ui/spinner"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"

export type AddGithubConnectorButtonProps = {
  orgSlug: string
  /** Called when a navigation or install flow has started (e.g. close the catalog). */
  onFlowStarted?: () => void
  /** After a self-hosted draft row is created (credentials saved); mirrors Confluence install intent. */
  onGithubInstallIntentRegistered?: (args: { connectionId: string }) => void
  /**
   * Opens the self-hosted wizard from a parent that stays mounted when the catalog closes.
   * Use this when this button lives inside `AddConnectorCatalogDialog`; otherwise closing the
   * catalog unmounts the inline `GithubSelfHostedWizardModal` and it disappears immediately.
   */
  onRequestSelfHostedWizard?: () => void
}

export function AddGithubConnectorButton({
  orgSlug,
  onFlowStarted,
  onGithubInstallIntentRegistered,
  onRequestSelfHostedWizard,
}: AddGithubConnectorButtonProps) {
  const navigate = useNavigate()

  const goToSharedSetup = useCallback(() => {
    navigate({
      to: "/$orgSlug/repositories/github/setup",
      params: { orgSlug },
      search: { returnTo: "connectors" },
    })
  }, [navigate, orgSlug])

  const { start, isPending, isSyncing, SelfHostedWizardModal } =
    useGithubConnectFlow({
      orgSlug,
      onAlreadyInstalled: () => {
        onFlowStarted?.()
        goToSharedSetup()
      },
      onRegistered: () => {
        goToSharedSetup()
      },
      onFlowStarted,
      onDraftCreated: onGithubInstallIntentRegistered,
      delegateSelfHostedWizard: onRequestSelfHostedWizard,
    })

  const busy = isPending || isSyncing

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className="group flex w-full items-start gap-4 rounded-none border border-border bg-card/40 p-4 text-left outline-none transition-colors hover:border-teal-400/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60"
        onClick={() => start()}
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
      {SelfHostedWizardModal}
    </>
  )
}
