"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import { useConnectorSync } from "@/features/workspace-sources/useConnectorSync"

import { resolveConnectorHealth } from "../connectorHealth"
import { getLinearCardPrimaryCta } from "../linear-setup-model"
import {
  deleteLinearConnector,
  fetchLinearConnectorStatus,
  fetchLinearOauthApp,
  linearConnectorKeys,
} from "../queries/linear-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConnectorListItem, connectorDash } from "./ConnectorListItem"
import { LinearMark } from "./LinearMark"

type LinearConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenWizard: () => void
}

export function LinearConnectionCard({
  orgSlug,
  connectionId,
  onOpenWizard,
}: LinearConnectionCardProps) {
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: linearConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorStatus(orgSlug, connectionId),
  })
  const oauthQuery = useQuery({
    queryKey: linearConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchLinearOauthApp(orgSlug, connectionId),
  })
  const removeMutation = useMutation({
    mutationFn: () => deleteLinearConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Linear connector removed.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.allStatusForOrg(orgSlug),
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const status = statusQuery.data
  const oauthMeta = oauthQuery.data
  const primary = status ? getLinearCardPrimaryCta(status, oauthMeta) : null
  const health = resolveConnectorHealth({
    installationStatus: status?.installationStatus,
    statusError: statusQuery.isError,
    checking: statusQuery.isPending || !status,
    connected: Boolean(status?.isInstalled),
    draft: !status?.isInstalled,
  })

  const sync = useConnectorSync({
    orgSlug,
    connectionId,
    provider: "linear",
  })

  return (
    <ConnectorListItem
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="linear"
        />
      }
      sync={sync}
      name="Linear"
      icon={<LinearMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the Linear authorization. Its Workspace sources stop syncing. The source files and the files already committed to Git stay.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.workspaceName)}
      actionLabel={
        statusQuery.isError ? "Retry" : primary ? primary.label : undefined
      }
      onAction={
        statusQuery.isError
          ? () => void statusQuery.refetch()
          : primary
            ? () => onOpenWizard()
            : undefined
      }
    >
      {statusQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
