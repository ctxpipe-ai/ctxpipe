"use client"

import {
  IconAlertCircle,
  IconBrandSlack,
  IconCircleCheckFilled,
  IconDotsVertical,
  IconExternalLink,
} from "@tabler/icons-react"
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
import { getSlackSetupPhaseLabel } from "../slack-setup-model"
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
  } = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSlackConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Slack connector removed.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: slackConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
      ])
      setRemoveOpen(false)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Remove failed")
    },
  })

  return (
    <>
      <Card
        size="sm"
        className="h-auto min-h-0 rounded-none [&>span[aria-hidden]]:hidden"
      >
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
              <Button
                variant="ghost"
                size="icon"
                aria-label="Connector actions"
              >
                <IconDotsVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => setRemoveOpen(true)}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          {isError ? (
            <div className="flex items-start gap-2">
              <IconAlertCircle
                className="mt-0.5 size-4 shrink-0 text-amber-500/90"
                aria-hidden
              />
              <p>Something went wrong while loading this connector.</p>
            </div>
          ) : isPending || !status ? (
            <div className="flex items-center gap-2">
              <Spinner className="size-4" />
              Checking connector…
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 font-medium text-foreground">
                {status.setupPhase === "live" ? (
                  <IconCircleCheckFilled
                    className="size-5 shrink-0 text-emerald-500"
                    aria-hidden
                  />
                ) : null}
                {getSlackSetupPhaseLabel(status)}
              </div>
              <dl className="flex flex-col gap-3">
                <div>
                  <dt className="font-medium text-muted-foreground">
                    Synchronised repository
                  </dt>
                  <dd className="mt-1 text-foreground">
                    {status.syncTarget ? (
                      <>
                        {status.syncTarget.repositoryName}
                        <span className="text-muted-foreground">
                          {" "}
                          · branch {status.syncTarget.branch}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        Not selected
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">
                    Channel scope
                  </dt>
                  <dd className="mt-1 text-foreground">
                    {status.selectedChannelCount === 0
                      ? "No channels selected"
                      : `${status.selectedChannelCount} channel${
                          status.selectedChannelCount === 1 ? "" : "s"
                        } selected`}
                  </dd>
                </div>
              </dl>
              {status.pendingConfigPullUrl ? (
                <div>
                  <a
                    href={status.pendingConfigPullUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
                  >
                    <IconExternalLink className="size-3.5" aria-hidden />
                    Open config pull request
                  </a>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => setSetupOpen(true)}
          >
            {status?.setupPhase === "live"
              ? "Manage channels"
              : status?.isInstalled
                ? "Continue setup"
                : "Set up"}
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
