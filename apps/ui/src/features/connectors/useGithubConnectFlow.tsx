"use client"

import HyperDX from "@hyperdx/browser"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { GithubSelfHostedWizardModal } from "@/features/connectors/components/GithubSelfHostedWizardModal"
import { getGithubConnectStartBranch } from "@/features/connectors/githubConnectFlow"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import {
  beginGithubPopupFlow,
  clearGithubPopupFlow,
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  GITHUB_SETUP_RESULT_KEY,
  GITHUB_SETUP_RESULT_MESSAGE,
  type GithubSetupPopupResult,
  githubLinkErrorMessage,
  githubLinkPopupUrl,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
  withGithubPopupState,
} from "@/lib/popup"
import { useGithubSignInEnabled } from "@/lib/useGetAuthConfig"
import { useGithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"

type UseGithubConnectFlowOptions = {
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

  // The backend attaches an installation through the deployment's App only
  // for a user whose linked GitHub account can see it. With GitHub sign-in,
  // the popup links the account first, then installs, in one flow. Wait for
  // the config: without it, a click would skip the link step.
  const githubSignIn = useGithubSignInEnabled()

  const hasHostedApp = bootstrapPending
    ? null
    : Boolean(bootstrap?.hostedDefaultAppInstallUrl)

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
    (result: GithubSetupPopupResult) => {
      if (result.status === "link_failed") {
        onRegistrationFailed?.(githubLinkErrorMessage(result.linkError))
        return
      }
      const { status } = result
      if (status === "redirected") return
      if (status === "registered") {
        HyperDX.addAction("connector_connect", { connector: "github" })
        onRegistered?.()
      } else if (status === "registration_failed")
        onRegistrationFailed?.(
          "Could not complete GitHub connection. Please try again.",
        )
      else if (status === "no_result")
        onRegistrationFailed?.(
          "GitHub setup finished but no callback result was received. Please verify callback URLs and try again.",
        )
    },
    [onRegistered, onRegistrationFailed],
  )

  const openManagedInstallPopup = useCallback(
    (url: string) => {
      onFlowStarted?.()
      try {
        localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
        localStorage.removeItem(GITHUB_SETUP_RESULT_KEY)
      } catch {
        // ignore
      }
      setGithubSetupOrgHint(orgSlug)
      setInstallStarting(true)
      const popupFlowNonce = beginGithubPopupFlow()
      const installUrl = withGithubPopupState(url, popupFlowNonce)
      const popup = openCenteredPopup(
        githubSignIn ? githubLinkPopupUrl(installUrl) : installUrl,
        {
          name: GITHUB_POPUP_NAME,
          width: 1120,
          height: 780,
          // Without a popup, /.github/setup links the account after the install.
          fallbackUrl: installUrl,
        },
      )
      if (!popup) {
        clearGithubPopupFlow()
        setInstallStarting(false)
        return
      }
      watchPopupClose(
        popup,
        () => {
          setInstallStarting(false)
          setIsSyncing(true)
          void (async () => {
            const result = await handleGithubSetupPopupResult(
              orgSlug,
              queryClient,
            )
            setIsSyncing(false)
            handleInstallSettled(result)
          })()
        },
        {
          resultKey: GITHUB_SETUP_RESULT_KEY,
          messageType: GITHUB_SETUP_RESULT_MESSAGE,
        },
      )
    },
    [
      onFlowStarted,
      orgSlug,
      watchPopupClose,
      queryClient,
      handleInstallSettled,
      githubSignIn,
    ],
  )

  const start = useCallback(
    (intent: "connect" | "manage_scope") => {
      if (!orgSlug.trim() || githubSignIn === undefined) return
      if (intent === "manage_scope" && installation?.appSlug?.trim()) {
        openManagedInstallPopup(
          `https://github.com/apps/${encodeURIComponent(
            installation.appSlug.trim(),
          )}/installations/select_target`,
        )
        return
      }
      const branch = getGithubConnectStartBranch({
        installationPending,
        installation,
        bootstrapPending,
        hostedDefaultAppInstallUrl: bootstrap?.hostedDefaultAppInstallUrl,
        intent,
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
        const hostedUrl = bootstrap?.hostedDefaultAppInstallUrl
        if (!hostedUrl) return
        openManagedInstallPopup(hostedUrl)
        return
      }

      // self_hosted_wizard
      if (delegateSelfHostedWizard) {
        delegateSelfHostedWizard()
        return
      }
      onFlowStarted?.()
      setSelfHostedWizardOpen(true)
    },
    [
      installation,
      installationPending,
      bootstrapPending,
      bootstrap?.hostedDefaultAppInstallUrl,
      orgSlug,
      onAlreadyInstalled,
      onFlowStarted,
      delegateSelfHostedWizard,
      openManagedInstallPopup,
      githubSignIn,
    ],
  )

  const showInlineSelfHostedWizard = delegateSelfHostedWizard == null

  return {
    start,
    isPending:
      installationPending ||
      bootstrapPending ||
      installStarting ||
      githubSignIn === undefined,
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
        onInstallPopupSettled={handleInstallSettled}
      />
    ) : null,
  }
}
