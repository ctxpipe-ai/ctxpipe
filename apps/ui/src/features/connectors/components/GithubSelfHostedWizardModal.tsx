"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Modal } from "@/components/ui/Modal"
import { GithubSelfHostedCredentialsStep } from "@/features/connectors/components/github-setup/steps/GithubSelfHostedCredentialsStep"
import { GithubSelfHostedInstallStep } from "@/features/connectors/components/github-setup/steps/GithubSelfHostedInstallStep"
import {
  createGithubDraftConnection,
  fetchGithubConnectorStatus,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import { githubAppInstallSelectTargetUrl } from "@/lib/github-app-url"
import type { GithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"
import {
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"

type GithubSelfHostedWizardModalProps = {
  orgSlug: string
  bootstrap: GithubConnectorBootstrap | undefined
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onInstallFlowStarted?: () => void
  onDraftCreated?: (args: { connectionId: string }) => void
}

export function GithubSelfHostedWizardModal({
  orgSlug,
  bootstrap,
  isOpen,
  onOpenChange,
  onInstallFlowStarted,
  onDraftCreated,
}: GithubSelfHostedWizardModalProps) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const [step, setStep] = useState<"credentials" | "install">("credentials")
  const [githubAppId, setGithubAppId] = useState("")
  const [appSlug, setAppSlug] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [webhookSecret, setWebhookSecret] = useState("")
  const [connectionId, setConnectionId] = useState<string | null>(null)

  const reset = useCallback(() => {
    setStep("credentials")
    setGithubAppId("")
    setAppSlug("")
    setPrivateKey("")
    setWebhookSecret("")
    setConnectionId(null)
  }, [])

  const draftMutation = useMutation({
    mutationFn: () =>
      createGithubDraftConnection(orgSlug, {
        githubAppId: githubAppId.trim(),
        appSlug: appSlug.trim(),
        privateKey,
        webhookSecret,
      }),
    onSuccess: (data) => {
      setConnectionId(data.id)
      setStep("install")
      onDraftCreated?.({ connectionId: data.id })
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.allInstallationForOrg(orgSlug),
      })
    },
    onError: (e: Error) => {
      toast.error(e.message)
    },
  })

  const { data: connectorStatus } = useQuery({
    queryKey:
      connectionId != null
        ? githubConnectorKeys.connectorStatus(orgSlug, connectionId)
        : ["github-connector-status", "disabled"],
    queryFn: () => fetchGithubConnectorStatus(orgSlug, connectionId!),
    enabled: isOpen && step === "install" && connectionId != null,
    refetchInterval: (q) => {
      const d = q.state.data
      if (d?.installationComplete) return false
      return 4000
    },
  })

  useEffect(() => {
    if (!connectorStatus?.installationComplete) return
    toast.success("GitHub installation linked.")
    onOpenChange(false)
    reset()
  }, [connectorStatus?.installationComplete, onOpenChange, reset])

  const webhookUrl =
    connectorStatus?.webhookUrl ??
    (connectionId && bootstrap
      ? bootstrap.suggestedWebhookUrlTemplate.replace(
          "<connectionId>",
          connectionId,
        )
      : null)

  const openGitHubInstall = () => {
    const slug = appSlug.trim()
    if (!slug) {
      toast.error("App slug is missing")
      return
    }
    onInstallFlowStarted?.()
    try {
      const url = githubAppInstallSelectTargetUrl(slug)
      localStorage.setItem(GITHUB_DRAFT_CONNECTION_KEY, connectionId ?? "")
      setGithubSetupOrgHint(orgSlug)
      onOpenChange(false)
      const popup = openCenteredPopup(url, {
        name: GITHUB_POPUP_NAME,
        width: 1120,
        height: 780,
      })
      if (popup) {
        watchPopupClose(popup, () => {
          void handleGithubSetupPopupResult(orgSlug, queryClient)
          localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
          reset()
        })
      }
    } catch {
      toast.error("Invalid GitHub App slug")
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) reset()
        onOpenChange(open)
      }}
      isDismissable
      className="max-w-[min(92vw,640px)]"
    >
      <div className="p-6">
        <h2 className="text-lg font-medium tracking-tight text-foreground">
          Connect your GitHub App
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your App credentials stay encrypted in this deployment. Register a
          webhook URL that includes your connection id after this step.
        </p>

        {step === "credentials" ? (
          <GithubSelfHostedCredentialsStep
            githubAppId={githubAppId}
            setGithubAppId={setGithubAppId}
            appSlug={appSlug}
            setAppSlug={setAppSlug}
            privateKey={privateKey}
            setPrivateKey={setPrivateKey}
            webhookSecret={webhookSecret}
            setWebhookSecret={setWebhookSecret}
            draftPending={draftMutation.isPending}
            onSubmit={() => draftMutation.mutate()}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <GithubSelfHostedInstallStep
            webhookUrl={webhookUrl}
            onBack={() => setStep("credentials")}
            onOpenGitHubInstall={openGitHubInstall}
          />
        )}
      </div>
    </Modal>
  )
}
