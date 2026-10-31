"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { getBuildkiteCardCtaLabel } from "../buildkite-setup-model"
import { resolveConnectorHealth } from "../connectorHealth"
import {
  buildkiteConnectorKeys,
  deleteBuildkiteConnector,
  fetchBuildkiteConnectorStatus,
} from "../queries/buildkite-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { BuildkiteMark } from "./BuildkiteMark"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"

type BuildkiteConnectionCardProps = {
  orgSlug: string
  connectionId: string
  /** The catalog Fix marks the card for a moment. */
  marked?: boolean
  onOpenSetup: (options?: { replaceWebhook: true }) => void
}

export function BuildkiteConnectionCard({
  orgSlug,
  connectionId,
  marked,
  onOpenSetup,
}: BuildkiteConnectionCardProps) {
  const queryClient = useQueryClient()
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: buildkiteConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchBuildkiteConnectorStatus(orgSlug, connectionId),
  })
  const removeMutation = useMutation({
    mutationFn: () => deleteBuildkiteConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Buildkite connector removed.")
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const sync = useConnectorSync({
    orgSlug,
    connectionId,
    provider: "buildkite",
  })
  // A connection holds auth only (ADR-050): a saved token is connected.
  const health = resolveConnectorHealth({
    installationStatus: status?.status,
    statusError: isError,
    checking: isPending,
    connected: status?.status === "installed",
    draft: false,
  })
  const actionLabel = status ? getBuildkiteCardCtaLabel(status) : null

  return (
    <ConnectorListItem
      connectionId={connectionId}
      marked={marked}
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="buildkite"
        />
      }
      sync={sync}
      name="Buildkite"
      icon={<BuildkiteMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the Buildkite connection and its saved tokens. The Workspace sources that use it stop syncing. Files already in GitHub stay in place. Delete the webhook in Buildkite too.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.organizationSlug)}
      actionLabel={isError ? "Retry" : (actionLabel ?? undefined)}
      onAction={
        isError
          ? () => void refetch()
          : actionLabel
            ? () => onOpenSetup()
            : undefined
      }
    >
      {status?.status === "revoked" ? (
        <p className="text-sm text-muted-foreground">
          Buildkite does not accept the saved token. Reconnect with a new token.
        </p>
      ) : null}
      {status?.status === "installed" && !status.webhookConfigured ? (
        <p className="text-sm text-muted-foreground">
          Builds sync once a day until you add the webhook.
        </p>
      ) : null}
      {status?.status === "installed" && status.webhookConfigured ? (
        <Button
          variant="quiet"
          className="self-start rounded-md"
          onPress={() => onOpenSetup({ replaceWebhook: true })}
        >
          Replace the webhook token
        </Button>
      ) : null}
      {isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
