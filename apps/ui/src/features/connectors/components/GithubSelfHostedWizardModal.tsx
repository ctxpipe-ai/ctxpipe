"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import { Textarea } from "@/components/ui/textarea"
import { client } from "@/lib/api"
import { orgConnectionsKeys } from "@/features/connectors/queries/org-connections"
import { githubAppInstallSelectTargetUrl } from "@/lib/github-app-url"
import type { GithubConnectorBootstrap } from "@/lib/useGithubConnectorBootstrap"
import {
  GITHUB_DRAFT_CONNECTION_KEY,
  GITHUB_POPUP_NAME,
  openCenteredPopup,
  setGithubSetupOrgHint,
  handleGithubSetupPopupResult,
  useWatchPopupClose,
} from "@/lib/popup"

type GithubSelfHostedWizardModalProps = {
  orgSlug: string
  bootstrap: GithubConnectorBootstrap | undefined
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onInstallFlowStarted?: () => void
}

export function GithubSelfHostedWizardModal({
  orgSlug,
  bootstrap,
  isOpen,
  onOpenChange,
  onInstallFlowStarted,
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
    mutationFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.draft.$post as (arg: {
          param: { orgSlug: string }
          json: {
            githubAppId: string
            appSlug: string
            privateKey: string
            webhookSecret: string
          }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        json: {
          githubAppId: githubAppId.trim(),
          appSlug: appSlug.trim(),
          privateKey,
          webhookSecret,
        },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? "Failed to save connector")
      }
      return (await res.json()) as { id: string }
    },
    onSuccess: (data) => {
      setConnectionId(data.id)
      setStep("install")
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: ["github-installation", orgSlug],
      })
    },
    onError: (e: Error) => {
      toast.error(e.message)
    },
  })

  const webhookUrl =
    connectionId && bootstrap
      ? bootstrap.suggestedWebhookUrlTemplate.replace(
          "<connectionId>",
          connectionId,
        )
      : null

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
      size="wide"
      className="max-w-[min(92vw,640px)]"
    >
      <div className="p-1">
        <h2 className="text-lg font-medium text-foreground">
          Connect your GitHub App
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your App credentials stay encrypted in this deployment. Register a
          webhook URL that includes your connection id after this step.
        </p>

        {step === "credentials" ? (
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              draftMutation.mutate()
            }}
          >
            <TextField
              label="GitHub App ID"
              type="text"
              value={githubAppId}
              onChange={setGithubAppId}
              isRequired
              description="Numeric App ID from the GitHub App settings page."
            />
            <TextField
              label="App slug"
              type="text"
              value={appSlug}
              onChange={setAppSlug}
              isRequired
              description="Public slug in the app URL: github.com/apps/your-slug"
            />
            <div>
              <label
                htmlFor="gh-pem"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Private key (PEM)
              </label>
              <Textarea
                id="gh-pem"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="Paste the full PEM from GitHub App settings"
                className="min-h-32 font-mono text-xs"
                required
              />
            </div>
            <TextField
              label="Webhook secret"
              type="password"
              value={webhookSecret}
              onChange={setWebhookSecret}
              isRequired
              description="Generate a random secret; paste the same value into your GitHub App webhook settings."
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                className="rounded-none"
                onPress={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="rounded-none"
                isDisabled={draftMutation.isPending}
              >
                Save and continue
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="rounded-md border border-border bg-card/40 p-4 text-sm">
              <p className="font-medium text-foreground">1. Webhook URL</p>
              <p className="mt-1 text-muted-foreground">
                In your GitHub App settings, set the webhook URL to:
              </p>
              {webhookUrl ? (
                <code className="mt-2 block break-all rounded bg-muted/50 p-2 text-xs text-foreground">
                  {webhookUrl}
                </code>
              ) : null}
            </div>
            <div className="rounded-md border border-border bg-card/40 p-4 text-sm">
              <p className="font-medium text-foreground">
                2. Install the app on your account
              </p>
              <p className="mt-1 text-muted-foreground">
                Use the button below to open GitHub, choose where to install,
                then finish in the popup so we can link the installation.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                className="rounded-none"
                onPress={() => setStep("credentials")}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="primary"
                className="rounded-none"
                onPress={openGitHubInstall}
              >
                Open GitHub to install
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
