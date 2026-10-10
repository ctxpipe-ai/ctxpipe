"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
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
    draft: status?.setupPhase === "draft",
  })

  return (
    <>
      <ConnectorListItem
        name="PagerDuty"
        icon={<PagerdutyMark className="size-5 text-foreground" />}
        health={health}
        remove={{
          description:
            "This removes the PagerDuty connection and sync target for this organization. Existing mirrored files in GitHub are left in place.",
          onConfirm: () => removeMutation.mutate(),
        }}
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
              ? getPagerdutyCardCtaLabel(status, {
                  globalPagerdutyOAuthConfigured:
                    status.globalPagerdutyOAuthConfigured,
                  oauthAppSaved: status.oauthAppSaved,
                })
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
        {status?.installationStatus === "revoked" ? (
          <p className="text-sm text-muted-foreground">
            PagerDuty authorization is revoked; reconnect the account.
          </p>
        ) : null}
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
            <code className="rounded-md bg-muted px-1 py-0.5 text-[11px]">
              pagerduty/config.yaml
            </code>{" "}
            to enable syncing.
          </p>
        ) : null}
      </ConnectorListItem>
    </>
  )
}
