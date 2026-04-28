"use client"

import {
  IconAlertCircle,
  IconChevronDown,
  IconCircleCheckFilled,
  IconDotsVertical,
  IconInfoCircle,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import {
  CONFLUENCE_CARD_STEP_DEFS,
  getConfluenceCardCurrentIndex,
  getConfluenceCardPrimaryCta,
} from "../confluence-setup-model"
import {
  atlassianConnectorKeys,
  deleteAtlassianConnector,
  fetchAtlassianConnectorStatus,
} from "../queries/atlassian-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { ConfluenceMark } from "./ConfluenceMark"
import { ConfluenceStepper } from "./ConfluenceStepper"

type ConfluenceConnectionCardProps = {
  orgSlug: string
  connectionId: string
  onOpenWizard: () => void
  onOpenScope: () => void
}

const connectorPanelClass =
  "flex min-h-0 flex-col border border-border bg-transparent px-5 py-4 text-sm"

function ConfluenceConnectionCardHeader({ menu }: { menu?: ReactNode }) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-3">
      <div className="flex min-w-0 gap-3">
        <span className="ctx-node h-9 w-9">
          <ConfluenceMark className="size-6" />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="font-medium text-foreground">Atlassian Confluence</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Sync spaces and pages from your Confluence instance.
          </p>
        </div>
      </div>
      {menu ?? <span className="inline-flex h-8 w-8 shrink-0" aria-hidden />}
    </header>
  )
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
  const [stepsExpanded, setStepsExpanded] = useState(false)

  const {
    data: status,
    isPending,
    isError,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug, connectionId),
  })

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

  if (isError) {
    return (
      <article className={connectorPanelClass}>
        <ConfluenceConnectionCardHeader />
        <div className="mt-5 flex items-start gap-2 text-sm text-muted-foreground">
          <IconAlertCircle
            className="mt-0.5 size-4 shrink-0 text-amber-500/90"
            aria-hidden
          />
          <p className="min-w-0">
            Something went wrong while loading this connector. Try reloading the
            page.
          </p>
        </div>
        <div className="mt-5 flex justify-end">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={() => window.location.reload()}
          >
            Reload page
          </Button>
        </div>
      </article>
    )
  }

  if (isPending || !status) {
    return (
      <article className={connectorPanelClass}>
        <ConfluenceConnectionCardHeader />
        <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking connector…
        </div>
      </article>
    )
  }

  const currentIndex = getConfluenceCardCurrentIndex(status)
  const primary = getConfluenceCardPrimaryCta(currentIndex)
  const complete = currentIndex >= CONFLUENCE_CARD_STEP_DEFS.length

  return (
    <>
      <article className={connectorPanelClass}>
        <ConfluenceConnectionCardHeader
          menu={
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
          }
        />
        <div className="mt-5 min-h-0 flex-1 space-y-3">
          {complete ? (
            <div className="overflow-hidden rounded-none border border-border bg-card/40 transition-colors hover:border-teal-400/40">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/[0.03]"
                onClick={() => setStepsExpanded((e) => !e)}
                aria-expanded={stepsExpanded}
              >
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <IconCircleCheckFilled
                    className="size-5 shrink-0 text-emerald-500"
                    aria-hidden
                  />
                  Connected
                </span>
                <IconChevronDown
                  className={`size-5 shrink-0 text-muted-foreground transition-transform ${stepsExpanded ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </button>
              {stepsExpanded ? (
                <div className="px-3 pb-3 pt-2">
                  <ConfluenceStepper currentIndex={currentIndex} />
                </div>
              ) : null}
            </div>
          ) : (
            <ConfluenceStepper currentIndex={currentIndex} />
          )}

          {complete ? (
            <dl className="flex flex-col gap-3">
              <div className="min-w-0">
                <dt className="text-sm font-medium text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    Synchronised repository
                    <TooltipProvider delay={200}>
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          className="inline-flex shrink-0 rounded-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <IconInfoCircle className="size-4" aria-hidden />
                          <span className="sr-only">
                            How synchronised repository works
                          </span>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-[min(18rem,calc(100vw-2rem))]"
                        >
                          <p>
                            Confluence content is synchronised to this Git
                            branch first; ctx| ingests it from the repository.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </span>
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
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm font-medium text-muted-foreground">
                  Scopes
                </dt>
                <dd className="mt-1">
                  {status.selectedSpaces.length === 0 ? (
                    <span className="text-sm text-muted-foreground">
                      No spaces yet
                    </span>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {status.selectedSpaces.map((s) => (
                        <div
                          key={s.spaceKey}
                          className="text-sm text-foreground"
                        >
                          {s.spaceKey}
                          {s.spaceName ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · {s.spaceName}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </dd>
              </div>
            </dl>
          ) : null}

          {!complete && currentIndex >= 2 && !status.isGithubLinked ? (
            <p className="text-xs text-muted-foreground">
              Link GitHub and grant repo access from{" "}
              <button
                type="button"
                className="text-teal-500 underline-offset-2 hover:underline"
                onClick={() => {
                  void navigate({
                    to: "/$orgSlug/repositories",
                    params: { orgSlug },
                  })
                }}
              >
                Repositories
              </button>
              .
            </p>
          ) : null}
          {!complete &&
          currentIndex >= 3 &&
          status.isGithubLinked &&
          !status.syncTargetConfigured ? (
            <p className="text-xs text-muted-foreground">
              Choose a repo that is visible to the GitHub App installation for
              this org. Add or adjust linked repos under{" "}
              <button
                type="button"
                className="text-teal-500 underline-offset-2 hover:underline"
                onClick={() => {
                  void navigate({
                    to: "/$orgSlug/repositories",
                    params: { orgSlug },
                  })
                }}
              >
                Repositories
              </button>
              .
            </p>
          ) : null}
          {!complete && currentIndex >= 4 && status.selectedSpaceCount === 0 ? (
            <p className="text-xs text-muted-foreground">
              Select at least one Confluence space (and pages if needed) so
              content can sync.
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={() => {
              if (primary.kind === "open_wizard") onOpenWizard()
              else if (primary.kind === "navigate_repositories") {
                void navigate({
                  to: "/$orgSlug/repositories",
                  params: { orgSlug },
                })
              } else onOpenScope()
            }}
          >
            {primary.label}
          </Button>
        </div>
      </article>

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
