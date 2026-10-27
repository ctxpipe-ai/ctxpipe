"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { resolveConnectorHealth } from "../connectorHealth"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  deleteZendeskConnector,
  fetchZendeskConnectorStatus,
  zendeskConnectorKeys,
} from "../queries/zendesk-connector"
import { getZendeskCardCtaLabel } from "../zendesk-setup-model"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"
import { ZendeskMark } from "./ZendeskMark"

type ZendeskConnectionCardProps = {
  orgSlug: string
  connectionId: string
  /** With `reconnect`, the setup opens at the authorization. */
  onOpenSetup: (options?: { reconnect: true }) => void
}

export function ZendeskConnectionCard({
  orgSlug,
  connectionId,
  onOpenSetup,
}: ZendeskConnectionCardProps) {
  const queryClient = useQueryClient()
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: zendeskConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchZendeskConnectorStatus(orgSlug, connectionId),
  })
  const removeMutation = useMutation({
    mutationFn: () => deleteZendeskConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Zendesk connector removed.")
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const sync = useConnectorSync({ orgSlug, connectionId, provider: "zendesk" })
  // A connection holds auth only (ADR-050): it is connected after OAuth.
  const health = resolveConnectorHealth({
    installationStatus: status?.status,
    statusError: isError,
    checking: isPending,
    connected: status?.status === "installed",
    draft: status?.status === "pending",
  })
  const actionLabel = status ? getZendeskCardCtaLabel(status) : null

  return (
    <ConnectorListItem
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="zendesk"
        />
      }
      sync={sync}
      name="Zendesk"
      icon={<ZendeskMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the Zendesk connection, its saved tokens, and the webhook that ctxpipe added in Zendesk. The Workspace sources that use it stop syncing. Files already in GitHub stay in place.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.subdomain)}
      actionLabel={isError ? "Retry" : (actionLabel ?? undefined)}
      onAction={
        isError
          ? () => void refetch()
          : actionLabel
            ? () =>
                actionLabel === "Manage"
                  ? onOpenSetup()
                  : onOpenSetup({ reconnect: true })
            : undefined
      }
    >
      {status?.status === "installed" && !status.webhookConfigured ? (
        <p className="text-sm text-muted-foreground">
          Help Center articles sync once a day: Zendesk did not let ctxpipe add
          its webhook. Select Add the webhook, and connect as a Zendesk admin.
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
