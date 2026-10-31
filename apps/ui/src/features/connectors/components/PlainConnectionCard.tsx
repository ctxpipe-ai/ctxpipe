"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { resolveConnectorHealth } from "../connectorHealth"
import { getPlainCardCtaLabel } from "../plain-setup-model"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  deletePlainConnector,
  fetchPlainConnectorStatus,
  plainConnectorKeys,
} from "../queries/plain-connector"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"
import { PlainMark } from "./PlainMark"

type PlainConnectionCardProps = {
  orgSlug: string
  connectionId: string
  /** With `reconnect`, the setup opens at the key. */
  onOpenSetup: (options?: { reconnect: true }) => void
}

export function PlainConnectionCard({
  orgSlug,
  connectionId,
  onOpenSetup,
}: PlainConnectionCardProps) {
  const queryClient = useQueryClient()
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: plainConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchPlainConnectorStatus(orgSlug, connectionId),
  })
  const removeMutation = useMutation({
    mutationFn: () => deletePlainConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Plain connector removed.")
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const sync = useConnectorSync({ orgSlug, connectionId, provider: "plain" })
  // A connection holds auth only (ADR-050): a saved key is connected.
  const health = resolveConnectorHealth({
    installationStatus: status?.status,
    statusError: isError,
    checking: isPending,
    connected: status?.status === "installed",
    draft: false,
  })
  const actionLabel = status ? getPlainCardCtaLabel(status) : null

  return (
    <ConnectorListItem
      connectionId={connectionId}
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="plain"
        />
      }
      sync={sync}
      name="Plain"
      icon={<PlainMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the Plain connection, its saved key, and its webhook target in Plain. The Workspace sources that use it stop syncing. Files already in GitHub stay in place.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.workspaceName)}
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
      {status?.status === "revoked" ? (
        <p className="text-sm text-muted-foreground">
          Plain does not accept the saved key. Reconnect Plain and paste a new
          key.
        </p>
      ) : null}
      {status?.status === "installed" && !status.webhookConfigured ? (
        <p className="text-sm text-muted-foreground">
          Threads sync once a day: Plain did not accept the webhook. Reconnect
          Plain to try again.
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
