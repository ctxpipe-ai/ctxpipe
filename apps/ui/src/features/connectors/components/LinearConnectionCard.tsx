"use client"

import {
  IconAlertCircle,
  IconCircleCheckFilled,
  IconDotsVertical,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
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
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
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
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { LinearMark } from "./LinearMark"

type LinearConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenWizard: () => void
}

function LinearCardHeader({ withMenu }: { withMenu?: React.ReactNode }) {
  return (
    <CardHeader className="flex shrink-0 flex-row items-start justify-between gap-3 space-y-0">
      <div className="flex min-w-0 gap-3">
        <span className="ctx-node h-9 w-9">
          <LinearMark className="size-5 text-foreground" />
        </span>
        <div className="min-w-0 space-y-1">
          <CardTitle>Linear</CardTitle>
          <CardDescription>
            Sync Linear projects, issues and documents through Git.
          </CardDescription>
        </div>
      </div>
      {withMenu ?? <span className="inline-flex size-8" aria-hidden />}
    </CardHeader>
  )
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

  if (statusQuery.isError) {
    return (
      <Card size="sm" className="[&>span[aria-hidden]]:hidden">
        <LinearCardHeader />
        <CardContent className="flex items-start gap-2 pt-0 pb-5 text-sm text-muted-foreground">
          <IconAlertCircle
            className="mt-0.5 size-4 text-amber-500"
            aria-hidden
          />
          Could not load this connector.
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={() => void statusQuery.refetch()}
          >
            Retry
          </Button>
        </CardFooter>
      </Card>
    )
  }
  if (statusQuery.isPending || !statusQuery.data) {
    return (
      <Card size="sm" className="[&>span[aria-hidden]]:hidden">
        <LinearCardHeader />
        <CardContent className="flex items-center gap-2 pt-0 pb-5 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking connector...
        </CardContent>
      </Card>
    )
  }

  const status = statusQuery.data
  const currentIndex = getLinearSetupCurrentIndex(status)
  const complete = currentIndex >= LINEAR_SETUP_STEPS.length
  const primary = getLinearCardPrimaryCta(status)

  return (
    <>
      <Card size="sm" className="h-auto min-h-0 [&>span[aria-hidden]]:hidden">
        <LinearCardHeader
          withMenu={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Linear connector actions"
                    className="inline-flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    <IconDotsVertical className="size-5" aria-hidden />
                  </button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setRemoveOpen(true)}
                >
                  Remove connector
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <CardContent className="space-y-4 py-0">
          {complete ? (
            <div className="flex items-center gap-2 border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-sm font-medium text-foreground">
              <IconCircleCheckFilled
                className="size-5 text-emerald-500"
                aria-hidden
              />
              Connected
            </div>
          ) : (
            <ConnectorSetupStepper
              steps={LINEAR_SETUP_STEPS}
              currentIndex={currentIndex}
            />
          )}
          {status.setupPhase === "sync_failed" ? (
            <InlineAlert variant="error" title="Linear content sync failed">
              The connector configuration is saved. Open setup to retry the
              content mirror.
            </InlineAlert>
          ) : null}
          {status.setupPhase === "config_failed" ? (
            <InlineAlert
              variant="error"
              title="Linear configuration pull request failed"
            >
              Open setup to retry creating the configuration pull request.
            </InlineAlert>
          ) : null}
          {complete ? (
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="mt-1 text-foreground">
                  {status.workspaceName ?? "Linear workspace"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Scope</dt>
                <dd className="mt-1 text-foreground">
                  {status.selectedScopeCount} selected item
                  {status.selectedScopeCount === 1 ? "" : "s"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">
                  Synchronised repository
                </dt>
                <dd className="mt-1 text-foreground">
                  {status.syncTarget?.repositoryName ?? "—"}
                  {status.syncTarget ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · branch {status.syncTarget.branch}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
        <CardFooter className="mt-auto justify-end">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={() => {
              if (primary.kind === "navigate_repositories") {
                void navigate({
                  to: "/$orgSlug/repositories",
                  params: { orgSlug },
                })
              } else {
                onOpenWizard()
              }
            }}
          >
            {primary.label}
          </Button>
        </CardFooter>
      </Card>
      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove Linear connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the Linear authorisation, selected scope and sync state
          for this organisation. Mirrored files already committed to Git are not
          deleted.
        </AlertDialog>
      </Modal>
    </>
  )
}
