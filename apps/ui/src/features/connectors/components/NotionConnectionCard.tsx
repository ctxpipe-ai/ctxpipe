"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useConnectionNextStep } from "@/features/workspace-sources/connection-next-step"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { resolveConnectorHealth } from "../connectorHealth"
import { getNotionCardCtaLabel } from "../notion-setup-model"
import {
  deleteNotionConnector,
  fetchNotionConnectorStatus,
  fetchNotionOauthApp,
  notionConnectorKeys,
} from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"

type NotionConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenSetup: () => void
}

export function NotionConnectionCard({
  orgSlug,
  connectionId,
  onOpenSetup,
}: NotionConnectionCardProps) {
  const queryClient = useQueryClient()
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: notionConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchNotionConnectorStatus(orgSlug, connectionId),
  })
  const oauthAppQuery = useQuery({
    queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchNotionOauthApp(orgSlug, connectionId),
    enabled: status ? !status.isInstalled : false,
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteNotionConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Notion connector removed.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
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
    ? getNotionCardCtaLabel(status, oauthAppQuery.data)
    : null

  const sync = useConnectorSync({
    orgSlug,
    connectionId,
    provider: "notion",
  })

  return (
    <ConnectorListItem
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="notion"
        />
      }
      sync={sync}
      name="Notion"
      icon={<IconBrandNotion className="size-5 text-foreground" aria-hidden />}
      health={health}
      remove={{
        description:
          "This removes the Notion connection for this organization. The Workspace sources that use it stop syncing. Existing mirrored files in GitHub stay in place.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.workspaceName)}
      actionLabel={isError ? "Retry" : (actionLabel ?? undefined)}
      onAction={
        isError
          ? () => void refetch()
          : actionLabel
            ? () => onOpenSetup()
            : undefined
      }
    >
      {isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
