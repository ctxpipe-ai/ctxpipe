"use client"

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
  getPagerdutyCardCtaLabel,
  getPagerdutyFailureAction,
} from "../pagerduty-setup-model"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  deletePagerdutyConnector,
  fetchPagerdutyConnectorStatus,
  pagerdutyConnectorKeys,
} from "../queries/pagerduty-connector"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
  connectorDash,
  formatSyncRepositoryLine,
} from "./ConnectorListItem"
import { PagerdutyMark } from "./PagerdutyMark"

type PagerdutyConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenSetup: (manageScope: boolean) => void
}

export function PagerdutyConnectionCard({
  orgSlug,
  connectionId,
  onOpenSetup,
}: PagerdutyConnectionCardProps) {
  const queryClient = useQueryClient()
  const [removeOpen, setRemoveOpen] = useState(false)
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
          queryKey: pagerdutyConnectorKeys.config(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
      ])
      setRemoveOpen(false)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const failureAction = status ? getPagerdutyFailureAction(status) : null
  const live = status?.setupPhase === "live"
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending || !status,
    setupPhase: status?.setupPhase,
    connected: live,
  })

  return (
    <>
      <ConnectorListItem
        name="PagerDuty"
        icon={<PagerdutyMark className="size-5 text-foreground" />}
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="PagerDuty connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={connectorDash(status?.accountName)}
        scope={
          status?.selectedServiceCount != null
            ? formatSelectedItemCount(status.selectedServiceCount)
            : live
              ? "Configured"
              : "—"
        }
        syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
        actionLabel={
          isError
            ? "Retry"
            : status
              ? getPagerdutyCardCtaLabel(status)
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
        (status.selectedServiceCount ?? 0) > 0 ? (
          <p className="text-xs text-muted-foreground">
            Merge the open pull request for{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
              pagerduty/config.yaml
            </code>{" "}
            to enable syncing.
          </p>
        ) : null}
      </ConnectorListItem>

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove PagerDuty connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the PagerDuty connection and sync target for this
          organisation. Existing mirrored files in GitHub are left in place.
        </AlertDialog>
      </Modal>
    </>
  )
}
