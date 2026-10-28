"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useConnectionNextStep } from "@/features/workspace-sources/connection-next-step"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { resolveConnectorHealth } from "../connectorHealth"
import { getPagerdutyCardCtaLabel } from "../pagerduty-setup-model"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  deletePagerdutyConnector,
  fetchPagerdutyConnectorStatus,
  pagerdutyConnectorKeys,
} from "../queries/pagerduty-connector"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"
import { PagerdutyMark } from "./PagerdutyMark"

type PagerdutyConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenSetup: () => void
}

export function PagerdutyConnectionCard({
  orgSlug,
  connectionId,
  onOpenSetup,
}: PagerdutyConnectionCardProps) {
  const queryClient = useQueryClient()
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchPagerdutyConnectorStatus(orgSlug, connectionId),
  })

  const removeMutation = useMutation({
    mutationFn: () => deletePagerdutyConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("PagerDuty connector removed.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })
  // A connection holds auth only (ADR-050): it is connected once installed.
  // The header follows the next step: a connection whose Workspaces
  // wait for a source pull request shows "Awaiting merge".
  const nextStep = useConnectionNextStep(orgSlug, connectionId)
  const health = resolveConnectorHealth({
    installationStatus: status?.installationStatus,
    statusError: isError,
    checking: isPending || !status || nextStep.isPending,
    setupPhase: status?.setupPhase,
    connected: Boolean(status?.isInstalled),
    draft: !status?.isInstalled,
    awaitingMerge: nextStep.step?.kind === "merge",
  })
  const actionLabel = status
    ? getPagerdutyCardCtaLabel(status, {
        globalPagerdutyOAuthConfigured: status.globalPagerdutyOAuthConfigured,
        oauthAppSaved: status.oauthAppSaved,
      })
    : null

  const sync = useConnectorSync({
    orgSlug,
    connectionId,
    provider: "pagerduty",
  })

  return (
    <ConnectorListItem
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="pagerduty"
        />
      }
      sync={sync}
      name="PagerDuty"
      icon={<PagerdutyMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the PagerDuty connection for this organization. The Workspace sources that use it stop syncing. Existing mirrored files in GitHub stay in place.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.accountName)}
      actionLabel={isError ? "Retry" : (actionLabel ?? undefined)}
      onAction={
        isError
          ? () => void refetch()
          : actionLabel
            ? () => onOpenSetup()
            : undefined
      }
    >
      {status?.installationStatus === "revoked" ? (
        <p className="text-sm text-muted-foreground">
          PagerDuty authorization is revoked. Reconnect the account.
        </p>
      ) : null}
      {isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
