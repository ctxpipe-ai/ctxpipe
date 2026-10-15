"use client"

import HyperDX from "@hyperdx/browser"
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
  getLinearSetupCurrentIndex,
  getLinearSetupSteps,
  getLinearWizardBodyId,
} from "../../linear-setup-model"
import {
  fetchLinearConnectorStatus,
  fetchLinearOauthApp,
  linearConnectorKeys,
} from "../../queries/linear-connector"
import { ConnectorSetupStepper } from "../ConnectorSetupStepper"
import { LinearMark } from "../LinearMark"
import { LinearConnectStep } from "./LinearConnectStep"
import { RegisterLinearOauthStep } from "./RegisterLinearOauthStep"

type LinearSetupWizardProps = {
  orgSlug: string
  connectionId?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

/**
 * Connect Linear, then choose the Workspaces that sync from it. Each chosen
 * Workspace gets a Linear entry in its `.ctxpipe/sources.yaml` (ADR-050).
 */
export function LinearSetupWizard({
  orgSlug,
  connectionId,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: LinearSetupWizardProps) {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: linearConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
  })
  const oauthQuery = useQuery({
    queryKey: linearConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchLinearOauthApp(orgSlug, connectionId),
    enabled: isOpen,
  })
  // The pull requests that the save opened. As in the other setups, the
  // dialog then shows the merge step.
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  if (!isOpen && pullRequests.length) setPullRequests([])
  const close = () => onOpenChange(false)

  useEffect(() => {
    if (!isOpen) return
    const acceptResult = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (
        data.type === "linear-oauth-error" &&
        data.orgSlug === orgSlug &&
        typeof data.error === "string"
      ) {
        toast.error(data.error)
        return
      }
      if (
        data.type !== "linear-oauth-complete" ||
        data.orgSlug !== orgSlug ||
        typeof data.connectionId !== "string"
      ) {
        return
      }
      onConnectionIdChange(data.connectionId)
      HyperDX.addAction("connector_connect", { connector: "linear" })
      void queryClient.invalidateQueries({
        queryKey: linearConnectorKeys.allStatusForOrg(orgSlug),
      })
    }
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return
      acceptResult(event.data)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "linear-setup-result" || !event.newValue) return
      try {
        acceptResult(JSON.parse(event.newValue) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        window.localStorage.removeItem("linear-setup-result")
      }
    }
    const storedResult = window.localStorage.getItem("linear-setup-result")
    if (storedResult) {
      try {
        acceptResult(JSON.parse(storedResult) as unknown)
      } catch {
        // The signed OAuth callback is the only writer; ignore malformed values.
      } finally {
        window.localStorage.removeItem("linear-setup-result")
      }
    }
    window.addEventListener("message", handleMessage)
    window.addEventListener("storage", handleStorage)
    return () => {
      window.removeEventListener("message", handleMessage)
      window.removeEventListener("storage", handleStorage)
    }
  }, [isOpen, onConnectionIdChange, orgSlug, queryClient])

  const oauthMeta = oauthQuery.data
  const setupSteps = getLinearSetupSteps(oauthMeta)
  const status = connectionId ? statusQuery.data : { isInstalled: false }
  const body = status ? getLinearWizardBodyId(status, oauthMeta) : "connect"
  const loading =
    (Boolean(connectionId) && statusQuery.isPending) || oauthQuery.isPending

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
              <LinearMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Linear connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Authorize Linear, then choose the Workspaces that sync its teams
                and projects.
              </p>
            </div>
          </div>
          <Button variant="secondary" className="rounded-md" onPress={close}>
            Close
          </Button>
        </div>

        {status && !loading ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={setupSteps}
              currentIndex={
                pullRequests.length
                  ? setupSteps.length
                  : getLinearSetupCurrentIndex(status, oauthMeta)
              }
            />
          </div>
        ) : null}

        {loading ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading connector status...
          </div>
        ) : connectionId && statusQuery.isError ? (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">
              Could not load Linear connector status.
            </p>
            <Button
              variant="secondary"
              className="rounded-md"
              onPress={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : body === "register" && connectionId ? (
          <RegisterLinearOauthStep
            orgSlug={orgSlug}
            connectionId={connectionId}
          />
        ) : body === "connect" ? (
          <LinearConnectStep orgSlug={orgSlug} connectionId={connectionId} />
        ) : body === "workspaces" && pullRequests.length ? (
          <div className="space-y-4">
            <PullRequestsToMerge
              orgSlug={orgSlug}
              pullRequests={pullRequests}
            />
            <Button variant="secondary" className="rounded-md" onPress={close}>
              Close
            </Button>
          </div>
        ) : body === "workspaces" && connectionId ? (
          <AddToWorkspacesStep
            orgSlug={orgSlug}
            provider="linear"
            connectionId={connectionId}
            label="Linear"
            description="the teams and projects for each"
            items="the teams"
            onDone={setPullRequests}
          />
        ) : (
          <p className="text-sm text-destructive">
            The Linear connection identifier is missing. Close this dialog and
            reopen setup from the connector card.
          </p>
        )}
      </div>
    </Modal>
  )
}
