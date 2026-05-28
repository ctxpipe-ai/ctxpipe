"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { GithubSelfHostedWizardModal } from "@/features/connectors/components/GithubSelfHostedWizardModal"
import { getGithubConnectStartBranch } from "@/features/connectors/githubConnectFlow"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import {
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  type GithubSetupRegistrationStatus,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { resolveGithubInstallPopupUrl } from "@/lib/github-app-url"
import { useGithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"

export type UseGithubConnectFlowOptions = {
  orgSlug: string
  onAlreadyInstalled?: () => void
  onRegistered?: () => void
  onRegistrationFailed?: (message: string) => void
  /** Fired when the self-hosted wizard modal is dismissed (completed install or cancelled). */
  onWizardClosed?: () => void
  /** When set, self-hosted path calls this instead of opening the inline wizard (e.g. connectors catalog). */
  delegateSelfHostedWizard?: () => void
  /** Called when a flow begins: managed popup about to open, or inline wizard about to open. */
  onFlowStarted?: () => void
  onDraftCreated?: (args: { connectionId: string }) => void
  /** After `registered`, wait this many ms before calling `onRegistered` (onboarding polish). */
  minFinalizeAfterRegistrationMs?: number
}

export function useGithubConnectFlow({
  orgSlug,
  onAlreadyInstalled,
  onRegistered,
  onRegistrationFailed,
  onWizardClosed,
  delegateSelfHostedWizard,
  onFlowStarted,
  onDraftCreated,
  minFinalizeAfterRegistrationMs = 0,
}: UseGithubConnectFlowOptions) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const [installStarting, setInstallStarting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [selfHostedWizardOpen, setSelfHostedWizardOpen] = useState(false)

  const { data: bootstrap, isPending: bootstrapPending } =
    useGithubConnectorBootstrap(orgSlug)

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
    enabled: Boolean(orgSlug),
  })

  const hostedInstallUrl = resolveGithubInstallPopupUrl(
    bootstrap?.hostedDefaultAppInstallUrl,
  )

  const hasHostedApp = bootstrapPending ? null : Boolean(hostedInstallUrl)

  const onWizardOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onWizardClosed?.()
      setSelfHostedWizardOpen(open)
    },
    [onWizardClosed],
  )

  const onHandoffClose = useCallback(() => {
    setSelfHostedWizardOpen(false)
  }, [])

  const handleInstallSettled = useCallback(
    (status: GithubSetupRegistrationStatus) => {
      if (status === "registered") onRegistered?.()
      else if (status === "registration_failed")
        onRegistrationFailed?.(
          "Could not complete GitHub connection. Please try again.",
        )
    },
    [onRegistered, onRegistrationFailed],
  )

  const applyFinalizeDelay = useCallback(
    async (status: GithubSetupRegistrationStatus) => {
      if (minFinalizeAfterRegistrationMs > 0 && status === "registered") {
        await new Promise<void>((r) =>
          window.setTimeout(r, minFinalizeAfterRegistrationMs),
        )
      }
    },
    [minFinalizeAfterRegistrationMs],
  )

  const start = useCallback(() => {
    if (!orgSlug.trim()) return
    const branch = getGithubConnectStartBranch({
      installationPending,
      installation,
      bootstrapPending,
      hostedDefaultAppInstallUrl: hostedInstallUrl,
    })

    if (branch === "already_installed") {
      onAlreadyInstalled?.()
      return
    }
    if (
      branch === "noop_bootstrap_pending" ||
      branch === "noop_installation_pending"
    ) {
      return
    }
    if (branch === "managed_install") {
      if (!hostedInstallUrl) return
      onFlowStarted?.()
      try {
        localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
      } catch {
        // ignore
      }
      setGithubSetupOrgHint(orgSlug)
      setInstallStarting(true)
      const popup = openCenteredPopup(hostedInstallUrl, {
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
        setIsSyncing(true)
        void (async () => {
          const { status } = await handleGithubSetupPopupResult(
            orgSlug,
            queryClient,
          )
          await applyFinalizeDelay(status)
          setIsSyncing(false)
          handleInstallSettled(status)
        })()
      })
      return
    }

    // self_hosted_wizard
    if (delegateSelfHostedWizard) {
      delegateSelfHostedWizard()
      return
    }
    onFlowStarted?.()
    setSelfHostedWizardOpen(true)
  }, [
    installation,
    installationPending,
    bootstrapPending,
    hostedInstallUrl,
    orgSlug,
    queryClient,
    watchPopupClose,
    onAlreadyInstalled,
    onFlowStarted,
    delegateSelfHostedWizard,
    handleInstallSettled,
    applyFinalizeDelay,
  ])

  const showInlineSelfHostedWizard = delegateSelfHostedWizard == null

  return {
    start,
    isPending: installationPending || bootstrapPending || installStarting,
    isSyncing,
    selfHostedWizard: {
      isOpen: selfHostedWizardOpen,
      onOpenChange: onWizardOpenChange,
    },
    hasHostedApp,
    /** Render next to the trigger when not using `delegateSelfHostedWizard`. */
    SelfHostedWizardModal: showInlineSelfHostedWizard ? (
      <GithubSelfHostedWizardModal
        orgSlug={orgSlug}
        isOpen={selfHostedWizardOpen}
        onOpenChange={onWizardOpenChange}
        onInstallFlowStarted={onFlowStarted}
        onDraftCreated={onDraftCreated}
        onHandoffClose={onHandoffClose}
        onInstallPopupSettled={({ status }) => {
          void (async () => {
            await applyFinalizeDelay(status)
            handleInstallSettled(status)
          })()
        }}
      />
    ) : null,
  }
}
