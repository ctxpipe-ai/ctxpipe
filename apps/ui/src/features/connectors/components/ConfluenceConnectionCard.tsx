"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { ConnectorUsedIn } from "@/features/workspace-sources/ConnectorUsedIn"
import {
  getConfluenceCardCurrentIndex,
  getConfluenceCardPrimaryCta,
  getConfluenceCardStepDefs,
} from "../confluence-setup-model"
import {
  formatSelectedItemCount,
  resolveConnectorHealth,
} from "../connectorHealth"
import {
  atlassianConnectorKeys,
  deleteAtlassianConnector,
  fetchAtlassianConnectorStatus,
  fetchOrgAtlassianOauth,
} from "../queries/atlassian-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConfluenceMark } from "./ConfluenceMark"
import {
  ConnectorListItem,
  formatSyncRepositoryLine,
} from "./ConnectorListItem"

type ConfluenceConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenWizard: () => void
  onOpenScope: () => void
}

export function ConfluenceConnectionCard({
  orgSlug,
  connectionId,
  onOpenWizard,
  onOpenScope,
}: ConfluenceConnectionCardProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug, connectionId),
  })

  const {
    data: orgOauthData,
    isPending: oauthPending,
    isSuccess: oauthSuccess,
  } = useQuery({
    queryKey: atlassianConnectorKeys.orgAtlassianOauth(orgSlug, connectionId),
    queryFn: () => fetchOrgAtlassianOauth(orgSlug, connectionId),
  })

  const oauthForCard = oauthSuccess ? orgOauthData : undefined

  const removeMutation = useMutation({
    mutationFn: () => deleteAtlassianConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Confluence connector removed.")
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.status(orgSlug, connectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.config(orgSlug, connectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const stepDefs = getConfluenceCardStepDefs(oauthForCard)
  const currentIndex = status
    ? getConfluenceCardCurrentIndex(status, oauthForCard)
    : 0
  const primary = getConfluenceCardPrimaryCta(currentIndex, stepDefs)
  const live = status?.setupPhase === "live"
  const health = resolveConnectorHealth({
    installationStatus: status?.installationStatus,
    statusError: isError,
    checking: isPending || !status || oauthPending,
    setupPhase: status?.setupPhase,
    connected: live,
    draft: status?.setupPhase === "draft",
  })

  return (
    <ConnectorListItem
      usedIn={
        <ConnectorUsedIn
          orgSlug={orgSlug}
          connectionId={connectionId}
          provider="confluence"
        />
      }
      name="Atlassian Confluence"
      icon={
        <ConfluenceMark className="size-5 text-foreground" variant="outline" />
      }
      health={health}
      remove={{
        description:
          "This removes the Forge installation and Confluence scope for this organization. Your Atlassian account may stay linked to your user profile.",
        onConfirm: () => removeMutation.mutate(),
      }}
      workspace={status?.isLinked ? "Atlassian" : "—"}
      scope={status ? formatSelectedItemCount(status.selectedSpaceCount) : "—"}
      syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
      actionLabel={
        isError
          ? "Retry"
          : isPending || oauthPending
            ? undefined
            : primary.label
      }
      onAction={
        isError
          ? () => void refetch()
          : isPending || oauthPending
            ? undefined
            : () => {
                if (primary.kind === "open_wizard") onOpenWizard()
                else if (primary.kind === "navigate_repositories") {
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
                } else onOpenScope()
              }
      }
    >
      {live && !status?.isLinked ? (
        <p className="text-sm text-muted-foreground">
          Link your Atlassian account to change the scope of this connection.
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
