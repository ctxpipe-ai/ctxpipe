"use client"

import {
  IconChevronDown,
  IconCircleCheckFilled,
  IconDotsVertical,
  IconInfoCircle,
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
import { ConfluenceMark } from "./ConfluenceMark"
import { ConfluenceStepper } from "./ConfluenceStepper"

type ConfluenceConnectionCardProps = {
  orgSlug: string
  onOpenWizard: () => void
  onOpenScope: () => void
}

export function ConfluenceConnectionCard({
  orgSlug,
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
    refetch,
  } = useQuery({
    queryKey: atlassianConnectorKeys.status(orgSlug),
    queryFn: () => fetchAtlassianConnectorStatus(orgSlug),
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteAtlassianConnector(orgSlug),
    onSuccess: async () => {
      toast.success("Confluence connector removed.")
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.status(orgSlug),
      })
      await queryClient.invalidateQueries({
        queryKey: atlassianConnectorKeys.config(orgSlug),
      })
      setRemoveOpen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (isPending || !status) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
          <ConfluenceMark className="size-10" />
          <div className="min-w-0 space-y-1">
            <CardTitle>Atlassian Confluence</CardTitle>
            <CardDescription>Loading connection status…</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex items-center gap-2 py-0 text-sm text-zinc-400">
          <Spinner className="size-4" />
          Checking connector…
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
          <ConfluenceMark className="size-10" />
          <div className="min-w-0 space-y-1">
            <CardTitle>Atlassian Confluence</CardTitle>
            <CardDescription>Could not load connector status.</CardDescription>
          </div>
        </CardHeader>
        <CardFooter>
          <Button variant="secondary" onPress={() => void refetch()}>
            Retry
          </Button>
        </CardFooter>
      </Card>
    )
  }

  const currentIndex = getConfluenceCardCurrentIndex(status)
  const primary = getConfluenceCardPrimaryCta(currentIndex)
  const complete = currentIndex >= CONFLUENCE_CARD_STEP_DEFS.length

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex min-w-0 gap-4">
            <ConfluenceMark className="size-10" />
            <div className="min-w-0 space-y-1 -mt-1">
              <CardTitle>Atlassian Confluence</CardTitle>
              <CardDescription>
                Sync spaces and pages from your Confluence instance.
              </CardDescription>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Connector actions"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                >
                  <IconDotsVertical className="size-5" aria-hidden />
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
        <CardContent className="space-y-4 py-0">
          {complete ? (
            <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-zinc-700">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition hover:bg-zinc-900/80"
                onClick={() => setStepsExpanded((e) => !e)}
                aria-expanded={stepsExpanded}
              >
                <span className="flex items-center gap-2 font-medium text-zinc-100">
                  <IconCircleCheckFilled
                    className="size-5 shrink-0 text-emerald-500"
                    aria-hidden
                  />
                  Connected
                </span>
                <IconChevronDown
                  className={`size-5 shrink-0 text-zinc-500 transition-transform ${stepsExpanded ? "rotate-180" : ""}`}
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
            <dl className="flex flex-col gap-4">
              <div className="min-w-0">
                <dt className="text-sm font-medium text-zinc-500">
                  <span className="inline-flex items-center gap-1.5">
                    Synchronised repository
                    <TooltipProvider delay={200}>
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          className="inline-flex shrink-0 rounded-sm text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
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
                <dd className="mt-1 text-sm text-zinc-100">
                  {status.syncTarget ? (
                    <>
                      {status.syncTarget.repositoryName}
                      <span className="text-zinc-400">
                        {" "}
                        · branch {status.syncTarget.branch}
                      </span>
                    </>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm font-medium text-zinc-500">Scopes</dt>
                <dd className="mt-1">
                  {status.selectedSpaces.length === 0 ? (
                    <span className="text-sm text-zinc-400">No spaces yet</span>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {status.selectedSpaces.map((s) => (
                        <div key={s.spaceKey} className="text-sm text-zinc-100">
                          {s.spaceKey}
                          {s.spaceName ? (
                            <span className="text-zinc-400">
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
            <p className="text-xs text-zinc-500">
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
            <p className="text-xs text-zinc-500">
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
            <p className="text-xs text-zinc-500">
              Select at least one Confluence space (and pages if needed) so
              content can sync.
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button
            variant="primary"
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
        </CardFooter>
      </Card>

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove Confluence connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This removes the Forge installation and Confluence scope for this
          organization. Your Atlassian account may stay linked to your user
          profile.
        </AlertDialog>
      </Modal>
    </>
  )
}
