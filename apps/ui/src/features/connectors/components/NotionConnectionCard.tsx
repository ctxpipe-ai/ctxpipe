"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  formatSelectedItemCount,
  resolveConnectorHealth,
} from "../connectorHealth"
import {
  getNotionCardCtaLabel,
  getNotionFailureAction,
} from "../notion-setup-model"
import {
  deleteNotionConnector,
  fetchNotionConnectorStatus,
  fetchNotionOauthApp,
  notionConnectorKeys,
} from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  ConnectorListItem,
  connectorDash,
  formatSyncRepositoryLine,
} from "./ConnectorListItem"

type NotionConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenSetup: (manageScope: boolean) => void
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
    enabled: status?.setupPhase === "draft",
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
          queryKey: notionConnectorKeys.config(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const failureAction = status ? getNotionFailureAction(status) : null
  const live = status?.setupPhase === "live"
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending || !status,
    setupPhase: status?.setupPhase,
    connected: live,
    draft: status?.setupPhase === "draft",
  })

  return (
    <>
      <ConnectorListItem
        name="Notion"
        icon={
          <IconBrandNotion className="size-5 text-foreground" aria-hidden />
        }
        health={health}
        remove={{
          description:
            "This removes the Notion connection, selected scope, and sync target for this organization. Existing mirrored files in GitHub are left in place.",
          onConfirm: () => removeMutation.mutate(),
        }}
        workspace={connectorDash(status?.workspaceName)}
        scope={
          status?.selectedResourceCount != null
            ? formatSelectedItemCount(status.selectedResourceCount)
            : live
              ? "Configured"
              : "—"
        }
        syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
        actionLabel={
          isError
            ? "Retry"
            : status
              ? getNotionCardCtaLabel(status, oauthAppQuery.data)
              : undefined
        }
        onAction={
          isError
            ? () => void refetch()
            : status
              ? () => onOpenSetup(live)
              : undefined
        }
      >
        {failureAction ? (
          <p className="text-sm text-muted-foreground">
            {failureAction === "retry_content"
              ? "Content mirror failed. Open setup to retry."
              : "Configuration pull request failed. Open setup to retry."}
          </p>
        ) : null}
        {isError ? (
          <p className="text-sm text-muted-foreground">
            Status request failed. Retry, or open setup if this persists.
          </p>
        ) : null}
        {!failureAction &&
        status &&
        status.setupPhase !== "live" &&
        (status.selectedResourceCount ?? 0) > 0 ? (
          <p className="text-xs text-muted-foreground">
            Merge the open pull request for{" "}
            <code className="rounded-md bg-muted px-1 py-0.5 text-[11px]">
              notion/config.yaml
            </code>{" "}
            to enable syncing.
          </p>
        ) : null}
      </ConnectorListItem>
    </>
  )
}
