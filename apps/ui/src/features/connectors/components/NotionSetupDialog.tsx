"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"

import { useNotionOAuthConnect } from "../hooks/useNotionOAuthConnect"
import {
  getNotionSetupCurrentIndex,
  getNotionSetupSteps,
  shouldShowNotionRegisterStep,
  shouldShowNotionWebhookStep,
} from "../notion-setup-model"
import {
  fetchNotionConnectorStatus,
  fetchNotionOauthApp,
  notionConnectorKeys,
} from "../queries/notion-connector"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { AddNotionWebhookStep } from "./notion-setup/AddNotionWebhookStep"
import { RegisterNotionOauthStep } from "./notion-setup/RegisterNotionOauthStep"

type NotionSetupDialogProps = {
  orgSlug: string
  connectionId?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange?: (connectionId: string) => void
}

/**
 * Connect Notion, then add it to Workspaces (ADR-050). The connection holds
 * auth only; each Workspace keeps its pages and databases in its sources.
 */
export function NotionSetupDialog({
  orgSlug,
  connectionId,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: NotionSetupDialogProps) {
  const queryClient = useQueryClient()
  const oauthConnect = useNotionOAuthConnect(orgSlug)
  const [registerSaved, setRegisterSaved] = useState(false)
  const [webhookContinued, setWebhookContinued] = useState(false)
  // A save always opens pull requests: the dialog then shows the merge step.
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0
  if (!isOpen && (registerSaved || webhookContinued || workspacesDone)) {
    setRegisterSaved(false)
    setWebhookContinued(false)
    setPullRequests([])
  }

  const oauthAppQuery = useQuery({
    queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId ?? ""),
    queryFn: () => fetchNotionOauthApp(orgSlug, connectionId ?? ""),
    enabled: isOpen && Boolean(connectionId),
  })
  const statusQuery = useQuery({
    queryKey: notionConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchNotionConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
  })

  const status = statusQuery.data
  const oauthMeta = oauthAppQuery.data
    ? {
        ...oauthAppQuery.data,
        oauthAppSaved: oauthAppQuery.data.oauthAppSaved || registerSaved,
        // The stepper leaves the webhook step when the user continues.
        webhookConfigured: webhookContinued,
      }
    : undefined
  const setupSteps = getNotionSetupSteps(oauthMeta)
  const setupStepIndex = status
    ? getNotionSetupCurrentIndex(status, oauthMeta, { workspacesDone })
    : 0
  const showRegister = shouldShowNotionRegisterStep(oauthMeta)
  const showWebhook =
    shouldShowNotionWebhookStep(oauthMeta) && !webhookContinued

  const body = (() => {
    if (!connectionId) {
      return (
        <p className="text-sm text-muted-foreground">
          Open Add connection, then select Connect on the Notion row.
        </p>
      )
    }
    if (statusQuery.isPending || oauthAppQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading Notion connector...
        </div>
      )
    }
    if (!status?.isInstalled) {
      if (showRegister) {
        return (
          <RegisterNotionOauthStep
            orgSlug={orgSlug}
            connectionId={connectionId}
            onSaved={() => setRegisterSaved(true)}
          />
        )
      }
      if (showWebhook) {
        return (
          <AddNotionWebhookStep
            orgSlug={orgSlug}
            connectionId={connectionId}
            onContinue={() => setWebhookContinued(true)}
          />
        )
      }
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Connect Notion
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Authorize ctxpipe to read the Notion workspace. Then select the
              pages and databases for each Workspace.
            </p>
          </div>
          <Button
            variant="primary"
            className="rounded-md"
            isPending={oauthConnect.busy}
            onPress={() =>
              oauthConnect.start({
                connectionId,
                onFinished: async (result) => {
                  if (
                    result.connectionId &&
                    result.connectionId !== connectionId
                  ) {
                    onConnectionIdChange?.(result.connectionId)
                  }
                  await queryClient.invalidateQueries({
                    queryKey: notionConnectorKeys.status(
                      orgSlug,
                      result.connectionId ?? connectionId,
                    ),
                  })
                },
                onNotConfigured: () => {
                  void queryClient.invalidateQueries({
                    queryKey: notionConnectorKeys.oauthApp(
                      orgSlug,
                      connectionId,
                    ),
                  })
                },
              })
            }
          >
            Connect Notion
          </Button>
        </div>
      )
    }
    if (!workspacesDone) {
      return (
        <AddToWorkspacesStep
          orgSlug={orgSlug}
          provider="notion"
          connectionId={connectionId}
          label="Notion"
          description="the pages and databases for each"
          items="the pages"
          replacedConfigPullUrl={status.pendingConfigPullUrl}
          onDone={setPullRequests}
        />
      )
    }
    return (
      <div className="space-y-4">
        <PullRequestsToMerge orgSlug={orgSlug} pullRequests={pullRequests} />
        <Button
          variant="secondary"
          className="rounded-md"
          onPress={() => onOpenChange(false)}
        >
          Close
        </Button>
      </div>
    )
  })()

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandNotion className="size-5 text-foreground" aria-hidden />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Notion connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Complete each step to connect Notion to this organization.
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            className="rounded-md"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
        {status?.isInstalled || oauthAppQuery.data ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={setupSteps}
              currentIndex={setupStepIndex}
            />
          </div>
        ) : null}
        {body}
      </div>
    </Modal>
  )
}
