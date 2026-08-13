"use client"

import { IconAlertCircle } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Modal } from "@/components/ui/Modal"
import {
  getConfluenceCardCurrentIndex,
  getConfluenceCardPrimaryCta,
  getConfluenceCardStepDefs,
} from "../confluence-setup-model"
import {
  type ConnectorHealth,
  formatSelectedItemCount,
  isFailedSetupPhase,
} from "../connectorHealth"
import {
  atlassianConnectorKeys,
  deleteAtlassianConnector,
  fetchAtlassianConnectorStatus,
  fetchOrgAtlassianOauth,
} from "../queries/atlassian-connector"
import {
  CONNECTORS_PAGE_POLL_INTERVAL_MS,
  orgConnectionsKeys,
} from "../queries/org-connections"
import { ConfluenceMark } from "./ConfluenceMark"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
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
  const [removeOpen, setRemoveOpen] = useState(false)

  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
  })

  const {
    data: orgOauthData,
    isPending: oauthPending,
    isSuccess: oauthSuccess,
  } = useQuery({
    queryKey: atlassianConnectorKeys.orgAtlassianOauth(orgSlug, connectionId),
    queryFn: () => fetchOrgAtlassianOauth(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
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
      setRemoveOpen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const stepDefs = getConfluenceCardStepDefs(oauthForCard)
  const currentIndex = status
    ? getConfluenceCardCurrentIndex(status, oauthForCard)
    : 0
  const primary = getConfluenceCardPrimaryCta(currentIndex, stepDefs)
  const complete = status ? currentIndex >= stepDefs.length : false
  const health: ConnectorHealth = isError
    ? "error"
    : isPending || !status || oauthPending
      ? "checking"
      : isFailedSetupPhase(status.setupPhase)
        ? "error"
        : complete
          ? "connected"
          : "not_connected"

  return (
    <>
      <ConnectorListItem
        name="Atlassian Confluence"
        icon={
          <ConfluenceMark
            className="size-5 text-foreground"
            variant="outline"
          />
        }
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="Confluence connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={status?.isLinked ? "Atlassian" : "—"}
        scope={
          status ? formatSelectedItemCount(status.selectedSpaceCount) : "—"
        }
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
                      to: "/$orgSlug/repositories",
                      params: { orgSlug },
                    })
                  } else onOpenScope()
                }
        }
      >
        {isError ? (
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
          title="Remove Confluence connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the Forge installation and Confluence scope for this
          organisation. Your Atlassian account may stay linked to your user
          profile.
        </AlertDialog>
      </Modal>
    </>
  )
}
