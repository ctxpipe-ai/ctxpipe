"use client"

import { IconAlertCircle } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import {
  type ConnectorHealth,
  formatSelectedItemCount,
  isFailedSetupPhase,
} from "../connectorHealth"
import {
  getLinearCardPrimaryCta,
  getLinearSetupCurrentIndex,
  LINEAR_SETUP_STEPS,
} from "../linear-setup-model"
import {
  deleteLinearConnector,
  fetchLinearConnectorStatus,
  linearConnectorKeys,
} from "../queries/linear-connector"
import {
  CONNECTORS_PAGE_POLL_INTERVAL_MS,
  orgConnectionsKeys,
} from "../queries/org-connections"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
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
  const [removeOpen, setRemoveOpen] = useState(false)
  const statusQuery = useQuery({
    queryKey: linearConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorStatus(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
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
      setRemoveOpen(false)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const status = statusQuery.data
  const complete = status
    ? getLinearSetupCurrentIndex(status) >= LINEAR_SETUP_STEPS.length
    : false
  const primary = status ? getLinearCardPrimaryCta(status) : null
  const health: ConnectorHealth = statusQuery.isError
    ? "error"
    : statusQuery.isPending || !status
      ? "checking"
      : isFailedSetupPhase(status.setupPhase)
        ? "error"
        : complete
          ? "connected"
          : "not_connected"

  return (
    <>
      <ConnectorListItem
        name="Linear"
        icon={<LinearMark className="size-5 text-foreground" />}
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="Linear connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={connectorDash(status?.workspaceName)}
        scope={
          status ? formatSelectedItemCount(status.selectedScopeCount) : "—"
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
                      to: "/$orgSlug/repositories",
                      params: { orgSlug },
                    })
                  } else {
                    onOpenWizard(primary.kind === "manage_scope")
                  }
                }
              : undefined
        }
      >
        {status?.setupPhase === "sync_failed" ? (
          <InlineAlert variant="error" title="Linear content sync failed">
            The connector configuration is saved. Open setup to retry the
            content mirror.
          </InlineAlert>
        ) : null}
        {status?.setupPhase === "config_failed" ? (
          <InlineAlert
            variant="error"
            title="Linear configuration pull request failed"
          >
            Open setup to retry creating the configuration pull request.
          </InlineAlert>
        ) : null}
        {statusQuery.isError ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <IconAlertCircle
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden
            />
            Could not load this connector.
          </p>
        ) : null}
      </ConnectorListItem>
      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove Linear connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the Linear authorisation and repository binding from the
          connection. Scope configuration and mirrored files already committed
          to Git are not deleted.
        </AlertDialog>
      </Modal>
    </>
  )
}
