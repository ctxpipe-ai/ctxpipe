"use client"

import {
  IconAlertCircle,
  IconBrandSlack,
  IconCircleCheckFilled,
  IconDotsVertical,
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
  const [removed, setRemoved] = useState(false)

  const {
    data: status,
    isPending,
    isError,
  } = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    enabled: !removed,
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteSlackConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("Slack connector removed.")
      setRemoved(true)
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

  return (
    <>
      <Card size="sm" className="h-auto min-h-0 [&>span[aria-hidden]]:hidden">
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
                  : "Capture Slack threads into your context repository."}
              </CardDescription>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Connector actions"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <IconDotsVertical className="size-4" aria-hidden />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setRemoveOpen(true)}
              >
                Remove connector
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
                    Context repository
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
              </dl>
              {status.setupPhase === "live" ? (
                <p>
                  Invite the bot with{" "}
                  <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                    /invite @ctxpipe
                  </code>
                  , then mention{" "}
                  <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                    @ctxpipe
                  </code>{" "}
                  in a thread to capture it.
                </p>
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
              ? "Manage"
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
