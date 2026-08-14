"use client"

import { IconBrandNotion } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Modal } from "@/components/ui/Modal"
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
  notionConnectorKeys,
} from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
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
  const [removeOpen, setRemoveOpen] = useState(false)
  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: notionConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchNotionConnectorStatus(orgSlug, connectionId),
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
      setRemoveOpen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const failureAction = status ? getNotionFailureAction(status) : null
  const live =
    status?.setupPhase === "live" && (status.selectedResourceCount ?? 0) > 0
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending || !status,
    setupPhase: status?.setupPhase,
    connected: live,
  })

  return (
    <>
      <ConnectorListItem
        name="Notion"
        icon={
          <IconBrandNotion className="size-5 text-foreground" aria-hidden />
        }
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="Notion connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={connectorDash(status?.workspaceName)}
        scope={
          status ? formatSelectedItemCount(status.selectedResourceCount) : "—"
        }
        syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
        actionLabel={
          isError ? "Retry" : status ? getNotionCardCtaLabel(status) : undefined
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
        status.selectedResourceCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Merge the open pull request for{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
              notion/config.yaml
            </code>{" "}
            to enable syncing.
          </p>
        ) : null}
      </ConnectorListItem>

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove Notion connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the Notion connection, selected scope, and sync target
          for this organisation. Existing mirrored files in GitHub are left in
          place.
        </AlertDialog>
      </Modal>
    </>
  )
}
