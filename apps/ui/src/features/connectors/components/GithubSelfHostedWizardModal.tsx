"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Modal } from "@/components/ui/Modal"
import { GithubSelfHostedCredentialsStep } from "@/features/connectors/components/github-setup/steps/GithubSelfHostedCredentialsStep"
import {
  createGithubDraftPlaceholder,
  githubConnectorKeys,
  patchGithubDraftConnection,
} from "@/features/connectors/queries/github-connector"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import { githubAppInstallSelectTargetUrl } from "@/lib/github-app-url"
import { generateGithubWebhookSecret } from "@/lib/github-webhook-secret"
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
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onInstallFlowStarted?: () => void
  onDraftCreated?: (args: { connectionId: string }) => void
}

export function GithubSelfHostedWizardModal({
  orgSlug,
  isOpen,
  onOpenChange,
  onInstallFlowStarted,
  onDraftCreated,
}: GithubSelfHostedWizardModalProps) {
  const queryClient = useQueryClient()
  const watchPopupClose = useWatchPopupClose()
  const credentialsSavedRef = useRef(false)
  const openGitHubInstallRef = useRef<() => void>(() => {})

  const [githubAppId, setGithubAppId] = useState("")
  const [appSlug, setAppSlug] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [webhookSecret, setWebhookSecret] = useState(() =>
    generateGithubWebhookSecret(),
  )
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [reservedWebhookUrl, setReservedWebhookUrl] = useState<string | null>(
    null,
  )

  const placeholderMutation = useMutation({
    mutationFn: () => createGithubDraftPlaceholder(orgSlug),
    onSuccess: (data) => {
      setConnectionId(data.id)
      setReservedWebhookUrl(data.webhookUrl)
      onDraftCreated?.({ connectionId: data.id })
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (e: Error) => {
      toast.error(e.message)
    },
  })

  const patchDraftMutation = useMutation({
    mutationFn: () => {
      if (connectionId == null) {
        throw new Error("Connector is not reserved yet")
      }
      return patchGithubDraftConnection(orgSlug, {
        connectionId,
        githubAppId: githubAppId.trim(),
        appSlug: appSlug.trim(),
        privateKey,
        webhookSecret,
      })
    },
    onSuccess: () => {
      credentialsSavedRef.current = true
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.allInstallationForOrg(orgSlug),
      })
      openGitHubInstallRef.current()
    },
    onError: (e: Error) => {
      toast.error(e.message)
    },
  })

  const reset = useCallback(() => {
    credentialsSavedRef.current = false
    placeholderMutation.reset()
    patchDraftMutation.reset()
    setGithubAppId("")
    setAppSlug("")
    setPrivateKey("")
    setWebhookSecret(generateGithubWebhookSecret())
    setConnectionId(null)
    setReservedWebhookUrl(null)
  }, [placeholderMutation, patchDraftMutation])

  const openGitHubInstall = useCallback(() => {
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
          void (async () => {
            const { status } = await handleGithubSetupPopupResult(
              orgSlug,
              queryClient,
            )
            if (status === "registered") {
              toast.success("GitHub installation linked.")
            }
            localStorage.removeItem(GITHUB_DRAFT_CONNECTION_KEY)
            reset()
          })()
        })
      }
    } catch {
      toast.error("Invalid GitHub App slug")
    }
  }, [
    appSlug,
    connectionId,
    orgSlug,
    onInstallFlowStarted,
    onOpenChange,
    queryClient,
    watchPopupClose,
    reset,
  ])

  openGitHubInstallRef.current = openGitHubInstall

  useEffect(() => {
    if (!isOpen) return
    if (connectionId != null) return
    if (placeholderMutation.isPending || placeholderMutation.isSuccess) return
    void placeholderMutation.mutate()
  }, [isOpen, connectionId, placeholderMutation])

  const closeAndMaybeDeleteDraft = useCallback(
    (open: boolean) => {
      if (!open) {
        const id = connectionId
        const saved = credentialsSavedRef.current
        if (id != null && !saved) {
          void (async () => {
            await fetch(
              `/${orgSlug}/api/v1/github/installation?${new URLSearchParams({ connectionId: id })}`,
              { method: "DELETE", credentials: "include" },
            )
            await queryClient.invalidateQueries({
              queryKey: orgConnectionsKeys.list(orgSlug),
            })
          })()
        }
        credentialsSavedRef.current = false
        reset()
      }
      onOpenChange(open)
    },
    [connectionId, orgSlug, onOpenChange, queryClient, reset],
  )

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={closeAndMaybeDeleteDraft}
      isDismissable
      className="max-w-[min(92vw,640px)]"
    >
      <div className="p-6">
        <h2 className="text-lg font-medium tracking-tight text-foreground">
          Connect your GitHub App
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Follow the numbered steps on GitHub to register the app. The{" "}
          <strong className="font-medium text-foreground">Payload URL</strong>{" "}
          for your webhook is reserved below; copy the generated{" "}
          <strong className="font-medium text-foreground">webhook secret</strong>{" "}
          into GitHub. Then enter{" "}
          <strong className="font-medium text-foreground">App ID</strong>,{" "}
          <strong className="font-medium text-foreground">slug</strong>, and{" "}
          <strong className="font-medium text-foreground">private key</strong>{" "}
          here.{" "}
          <strong className="font-medium text-foreground">Install App</strong>{" "}
          stores your credentials and opens GitHub so you can install the app.
        </p>

        <div className="mt-6">
          <GithubSelfHostedCredentialsStep
            githubAppId={githubAppId}
            setGithubAppId={setGithubAppId}
            appSlug={appSlug}
            setAppSlug={setAppSlug}
            privateKey={privateKey}
            setPrivateKey={setPrivateKey}
            generatedWebhookSecret={webhookSecret}
            payloadUrl={reservedWebhookUrl}
            payloadUrlLoading={
              connectionId == null &&
              !placeholderMutation.isError &&
              !placeholderMutation.isSuccess
            }
            payloadUrlError={
              placeholderMutation.isError
                ? (placeholderMutation.error as Error).message
                : null
            }
            draftPending={patchDraftMutation.isPending}
            saveDisabled={connectionId == null || placeholderMutation.isError}
            onSubmit={() => patchDraftMutation.mutate()}
            onCancel={() => closeAndMaybeDeleteDraft(false)}
          />
        </div>
      </div>
    </Modal>
  )
}
