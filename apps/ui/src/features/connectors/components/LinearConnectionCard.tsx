"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import {
  formatSelectedItemCount,
  resolveConnectorHealth,
} from "../connectorHealth"
import {
  getLinearCardPrimaryCta,
  getLinearSetupCurrentIndex,
  getLinearSetupSteps,
  getLinearStatusRefetchInterval,
} from "../linear-setup-model"
import {
  deleteLinearConnector,
  fetchLinearConnectorStatus,
  fetchLinearOauthApp,
  linearConnectorKeys,
} from "../queries/linear-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  ConnectorListItem,
  connectorDash,
  formatSyncRepositoryLine,
} from "./ConnectorListItem"
import { LinearMark } from "./LinearMark"

type LinearConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenWizard: (manageScope: boolean) => void
}

export function LinearConnectionCard({
  orgSlug,
  connectionId,
  onOpenWizard,
}: LinearConnectionCardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    queryKey: linearConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorStatus(orgSlug, connectionId),
    refetchInterval: (query) =>
      query.state.status === "error"
        ? false
        : getLinearStatusRefetchInterval(query.state.data),
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
  const complete = status
    ? getLinearSetupCurrentIndex(status, oauthMeta) >=
      getLinearSetupSteps(oauthMeta).length
    : false
  const primary = status ? getLinearCardPrimaryCta(status, oauthMeta) : null
  const health = resolveConnectorHealth({
    installationStatus: status?.installationStatus,
    statusError: statusQuery.isError,
    checking: statusQuery.isPending || !status,
    setupPhase: status?.setupPhase,
    connected: complete,
    draft: status?.setupPhase === "draft",
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
      name="Linear"
      icon={<LinearMark className="size-5 text-foreground" />}
      health={health}
      remove={{
        description:
          "This removes the Linear authorization and repository binding from the connection. Scope configuration and mirrored files already committed to Git are not deleted.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={connectorDash(status?.workspaceName)}
      scope={
        status?.selectedScopeCount != null
          ? formatSelectedItemCount(status.selectedScopeCount)
          : status?.setupPhase === "live"
            ? "Configured"
            : "—"
      }
      syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
      actionLabel={
        statusQuery.isError ? "Retry" : primary ? primary.label : undefined
      }
      onAction={
        statusQuery.isError
          ? () => void statusQuery.refetch()
          : primary
            ? () => {
                if (primary.kind === "navigate_repositories") {
                  void navigate({
                    to: "/$orgSlug/connectors",
                    params: { orgSlug },
                    search: {
                      error: undefined,
                      error_description: undefined,
                      pendingAccountClaim: undefined,
                      notionConnectionId: undefined,
                    },
                  })
                } else {
                  onOpenWizard(primary.kind === "manage_scope")
                }
              }
            : undefined
      }
    >
      {status?.setupPhase === "initial_sync" ? (
        <p className="text-sm text-muted-foreground">
          Mirroring Linear content to Git.
        </p>
      ) : null}
      {status?.setupPhase === "sync_failed" ? (
        <p className="text-sm text-muted-foreground">
          Content mirror failed. Open setup to retry.
        </p>
      ) : null}
      {status?.setupPhase === "config_failed" ? (
        <p className="text-sm text-muted-foreground">
          Configuration pull request failed. Open setup to retry.
        </p>
      ) : null}
      {statusQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Status request failed. Retry, or open setup if this persists.
        </p>
      ) : null}
    </ConnectorListItem>
  )
}
