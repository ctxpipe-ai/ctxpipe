"use client"

import { IconBrandSlack, IconDotsVertical } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  CONNECTORS_PAGE_POLL_INTERVAL_MS,
  orgConnectionsKeys,
} from "../queries/org-connections"
import {
  deleteSlackConnector,
  fetchSlackConnectorStatus,
  slackConnectorKeys,
} from "../queries/slack-connector"
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

  const { data: status, isPending } = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSlackConnector(orgSlug, connectionId),
    onSuccess: () => {
      toast.success("Slack connector removed")
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Remove failed")
    },
  })

  return (
    <>
      <Card className="rounded-none">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandSlack className="size-5 text-foreground" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <CardTitle>Slack</CardTitle>
              <CardDescription>
                {status?.teamName
                  ? `Workspace: ${status.teamName}`
                  : "Mirror channels into your context repository."}
              </CardDescription>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Slack actions">
                <IconDotsVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setSetupOpen(true)}>
                Configure
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => setRemoveOpen(true)}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {isPending || !status ? (
            <Spinner className="size-4" />
          ) : (
            <ul className="space-y-1">
              <li>
                Status:{" "}
                <span className="text-foreground">
                  {status.setupPhase}
                  {status.pendingConfigPrCreating ? " (creating PR…)" : ""}
                </span>
              </li>
              <li>
                Channels selected:{" "}
                <span className="text-foreground">
                  {status.selectedChannelCount}
                </span>
              </li>
              {status.syncTarget ? (
                <li>
                  Target:{" "}
                  <span className="text-foreground">
                    {status.syncTarget.repositoryName} @{" "}
                    {status.syncTarget.branch}
                  </span>
                </li>
              ) : (
                <li>No sync target configured yet.</li>
              )}
              {status.pendingConfigPullUrl ? (
                <li>
                  <a
                    href={status.pendingConfigPullUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-teal-400 hover:text-teal-300"
                  >
                    Open config pull request
                  </a>
                </li>
              ) : null}
            </ul>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="secondary" onPress={() => setSetupOpen(true)}>
            Configure
          </Button>
        </CardFooter>
      </Card>

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
          actionLabel="Remove"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This deletes the Slack connection and selected channel draft. Mirrored
          files in Git are not deleted automatically.
        </AlertDialog>
      </Modal>
    </>
  )
}
