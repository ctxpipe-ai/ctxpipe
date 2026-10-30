"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"
import {
  consumePagerdutySetupPopupResult,
  PAGERDUTY_SETUP_RESULT_KEY,
} from "@/lib/popup"

import {
  getPagerdutySetupCurrentIndex,
  getPagerdutySetupSteps,
  shouldShowPagerdutyRegisterStep,
} from "../pagerduty-setup-model"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchPagerdutyConnectorStatus,
  pagerdutyConnectorKeys,
} from "../queries/pagerduty-connector"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { PagerdutyConnectStep } from "./PagerdutyConnectStep"
import { PagerdutyMark } from "./PagerdutyMark"
import { PagerdutyRegisterOauthStep } from "./PagerdutyRegisterOauthStep"

type PagerdutySetupDialogProps = {
  orgSlug: string
  connectionId?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

/**
 * Connect PagerDuty, then add it to Workspaces (ADR-050). The connection
 * holds auth only; each Workspace keeps its services in its sources.
 */
export function PagerdutySetupDialog({
  orgSlug,
  connectionId,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: PagerdutySetupDialogProps) {
  const queryClient = useQueryClient()
  // A save always opens pull requests: the dialog then shows the merge step.
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0
  if (!isOpen && workspacesDone) setPullRequests([])

  useEffect(() => {
    if (!isOpen) return
    const acceptResult = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (
        data.type === "pagerduty-oauth-error" &&
        data.orgSlug === orgSlug &&
        typeof data.error === "string"
      ) {
        toast.error(data.error)
        return
      }
      if (
        data.type !== "pagerduty-oauth-complete" ||
        data.orgSlug !== orgSlug ||
        typeof data.connectionId !== "string"
      ) {
        return
      }
      onConnectionIdChange(data.connectionId)
      void queryClient.invalidateQueries({
        queryKey: pagerdutyConnectorKeys.allStatusForOrg(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    }
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      acceptResult(event.data)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PAGERDUTY_SETUP_RESULT_KEY || !event.newValue) return
      try {
        acceptResult(JSON.parse(event.newValue) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        consumePagerdutySetupPopupResult()
      }
    }
    const storedResult = window.localStorage.getItem(PAGERDUTY_SETUP_RESULT_KEY)
    if (storedResult) {
      try {
        acceptResult(JSON.parse(storedResult) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        consumePagerdutySetupPopupResult()
      }
    }
    window.addEventListener("message", handleMessage)
    window.addEventListener("storage", handleStorage)
    return () => {
      window.removeEventListener("message", handleMessage)
      window.removeEventListener("storage", handleStorage)
    }
  }, [isOpen, onConnectionIdChange, orgSlug, queryClient])

  const statusQuery = useQuery({
    queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchPagerdutyConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
  })
  const status = statusQuery.data
  const oauthMeta = status
    ? {
        globalPagerdutyOAuthConfigured: status.globalPagerdutyOAuthConfigured,
        oauthAppSaved: status.oauthAppSaved,
      }
    : undefined
  const setupSteps = getPagerdutySetupSteps(oauthMeta)
  const setupStepIndex = status
    ? getPagerdutySetupCurrentIndex(status, oauthMeta, { workspacesDone })
    : 0

  const body = (() => {
    if (!connectionId) {
      return (
        <PagerdutyConnectStep orgSlug={orgSlug} connectionId={connectionId} />
      )
    }
    if (statusQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading…
        </div>
      )
    }
    if (statusQuery.isError || !status) {
      return (
        <div className="space-y-3 text-sm">
          <p className="text-destructive">
            Could not load PagerDuty connector status.
          </p>
          <Button
            variant="secondary"
            className="rounded-md"
            onPress={() => void statusQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )
    }
    if (shouldShowPagerdutyRegisterStep(status, oauthMeta)) {
      return (
        <PagerdutyRegisterOauthStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          oauthCallbackUrl={status.oauthCallbackUrl}
        />
      )
    }
    if (!status.isInstalled) {
      return (
        <PagerdutyConnectStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          revoked={status.installationStatus === "revoked"}
        />
      )
    }
    if (!workspacesDone) {
      return (
        <AddToWorkspacesStep
          orgSlug={orgSlug}
          provider="pagerduty"
          connectionId={connectionId}
          label="PagerDuty"
          description="the services for each"
          items="the services"
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
              <PagerdutyMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up PagerDuty connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect PagerDuty, then select the services for each Workspace.
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
        {status || !connectionId ? (
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
