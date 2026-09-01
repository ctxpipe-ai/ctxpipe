"use client"

import { IconBrandSlack } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Modal } from "@/components/ui/Modal"
import { resolveConnectorHealth } from "../connectorHealth"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  deleteSlackConnector,
  fetchSlackConnectorStatus,
  slackConnectorKeys,
} from "../queries/slack-connector"
import { formatSlackBotMention } from "../slack-setup-model"
import {
  ConnectorListItem,
  ConnectorRemoveMenu,
  connectorDash,
  formatSyncRepositoryLine,
} from "./ConnectorListItem"
import { SlackSetupDialog } from "./SlackSetupDialog"

type SlackConnectionCardProps = {
  orgSlug: string
  connectionId: string
}

export function SlackConnectionCard({
  orgSlug,
  connectionId,
}: SlackConnectionCardProps) {
  const queryClient = useQueryClient()
  const [setupOpen, setSetupOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)

  const {
    data: status,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSlackConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Slack connector removed.")
      setSetupOpen(false)
      setRemoveOpen(false)
      await queryClient.cancelQueries({
        queryKey: slackConnectorKeys.status(orgSlug, connectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      queryClient.removeQueries({
        queryKey: slackConnectorKeys.status(orgSlug, connectionId),
      })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Remove failed")
    },
  })

  const live = Boolean(status?.isInstalled && status.setupPhase === "live")
  const health = resolveConnectorHealth({
    statusError: isError,
    checking: isPending || !status,
    connected: Boolean(live),
  })

  return (
    <>
      <ConnectorListItem
        name="Slack"
        icon={<IconBrandSlack className="size-5 text-foreground" aria-hidden />}
        health={health}
        menu={
          <ConnectorRemoveMenu
            ariaLabel="Slack connector actions"
            onRemove={() => setRemoveOpen(true)}
          />
        }
        workspace={connectorDash(status?.teamName)}
        scope="—"
        syncRepository={formatSyncRepositoryLine(status?.syncTarget ?? null)}
        actionLabel={
          isError
            ? "Retry"
            : isPending || !status
              ? undefined
              : live
                ? "Manage"
                : status.isInstalled
                  ? "Continue setup"
                  : "Set up"
        }
        onAction={
          isError
            ? () => void refetch()
            : isPending || !status
              ? undefined
              : () => setSetupOpen(true)
        }
      >
        {isError ? (
          <p className="text-sm text-muted-foreground">
            Status request failed. Retry, or open setup if this persists.
          </p>
        ) : null}
        {live ? (
          <p className="text-sm text-muted-foreground">
            Invite the bot with{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
              /invite {formatSlackBotMention(status.botHandle)}
            </code>
            , then mention{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
              {formatSlackBotMention(status.botHandle)}
            </code>{" "}
            in a thread to capture it, or say capture this.
          </p>
        ) : null}
      </ConnectorListItem>

      <SlackSetupDialog
        orgSlug={orgSlug}
        connectionId={connectionId}
        isOpen={setupOpen}
        onOpenChange={setSetupOpen}
      />

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove Slack connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This deletes the Slack connection and context repository binding.
          Captured content already committed to Git is not deleted
          automatically.
        </AlertDialog>
      </Modal>
    </>
  )
}
