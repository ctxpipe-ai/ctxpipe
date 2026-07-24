"use client"

import {
  IconAlertCircle,
  IconBrandNotion,
  IconCircleCheckFilled,
  IconDotsVertical,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import {
  deleteNotionConnector,
  fetchNotionConnectorStatus,
  notionConnectorKeys,
} from "../queries/notion-connector"
import { orgConnectionsKeys } from "../queries/org-connections"

type NotionConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenSetup: () => void
}

const connectorPanelClass =
  "flex min-h-0 flex-col border border-border bg-transparent px-5 py-4 text-sm"

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

  return (
    <>
      <article className={connectorPanelClass}>
        <header className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandNotion className="size-5 text-foreground" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="font-medium text-foreground">Notion</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Sync selected pages and databases into a GitHub-backed context
                mirror.
              </p>
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
        </header>

        <div className="mt-5 min-h-0 flex-1 space-y-3">
          {isError ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <IconAlertCircle
                className="mt-0.5 size-4 shrink-0 text-amber-500/90"
                aria-hidden
              />
              <p>Something went wrong while loading this connector.</p>
            </div>
          ) : isPending || !status ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Checking connector...
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                {status.setupPhase === "live" &&
                status.selectedResourceCount > 0 ? (
                  <IconCircleCheckFilled
                    className="size-5 text-emerald-500"
                    aria-hidden
                  />
                ) : null}
                {status.workspaceName ?? "Notion workspace"}
              </div>
              <dl className="flex flex-col gap-3">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Synchronised repository
                  </dt>
                  <dd className="mt-1 text-sm text-foreground">
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
                  <dt className="text-sm font-medium text-muted-foreground">
                    Scope
                  </dt>
                  <dd className="mt-1 text-sm text-foreground">
                    {status.selectedResourceCount === 0
                      ? "No resources selected"
                      : `${status.selectedResourceCount} resource${
                          status.selectedResourceCount === 1 ? "" : "s"
                        } selected`}
                  </dd>
                </div>
                {status.setupPhase !== "live" &&
                status.selectedResourceCount > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Merge the open pull request for{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      notion/config.yaml
                    </code>{" "}
                    to enable syncing.
                  </div>
                ) : null}
              </dl>
            </>
          )}
        </div>

        <div className="mt-5 flex shrink-0 justify-end">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={onOpenSetup}
          >
            {status?.selectedResourceCount ? "Manage scope" : "Set up"}
          </Button>
        </div>
      </article>

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
