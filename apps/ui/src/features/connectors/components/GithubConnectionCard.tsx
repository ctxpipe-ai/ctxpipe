"use client"

import { IconBrandGithub, IconDotsVertical } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
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
import { githubConnectorKeys } from "@/features/connectors/queries/github-connector"
import {
  CONNECTORS_PAGE_POLL_INTERVAL_MS,
  orgConnectionsKeys,
} from "../queries/org-connections"

type GithubConnectionCardProps = {
  orgSlug: string
  connectionId: string
}

async function deleteGithubConnector(
  orgSlug: string,
  connectionId: string,
): Promise<void> {
  const qs = new URLSearchParams({ connectionId })
  const res = await fetch(
    `/${orgSlug}/api/v1/github/installation?${qs.toString()}`,
    { method: "DELETE", credentials: "include" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Failed to remove connector")
  }
}

export function GithubConnectionCard({
  orgSlug,
  connectionId,
}: GithubConnectionCardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [removeOpen, setRemoveOpen] = useState(false)
  const { data: installation, isPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
    refetchInterval: CONNECTORS_PAGE_POLL_INTERVAL_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ connectionId })
      const res = await fetch(
        `/${orgSlug}/api/v1/github/installation?${qs.toString()}`,
        { credentials: "include" },
      )
      if (!res.ok) throw new Error("Failed to load GitHub connection")
      return (await res.json()) as {
        id: string
        installationId: number | null
        accountSlug: string | null
        ingestionRepositoryCount: number
      } | null
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteGithubConnector(orgSlug, connectionId),
    onSuccess: async () => {
      toast.success("GitHub connector removed.")
      await queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
      })
      await queryClient.invalidateQueries({
        queryKey: githubConnectorKeys.allInstallationForOrg(orgSlug),
      })
      await queryClient.invalidateQueries({
        queryKey: ["github-installation-repos-preview", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: ["github-installation-setup", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: ["repositories", orgSlug],
      })
      await queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      setRemoveOpen(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const accountDisplay = isPending ? (
    <span className="text-muted-foreground">Loading…</span>
  ) : installation ? (
    installation.installationId == null ? (
      <span className="text-muted-foreground">Install not linked yet</span>
    ) : installation.accountSlug ? (
      installation.accountSlug
    ) : (
      <span className="text-muted-foreground">
        Installation #{installation.installationId}
      </span>
    )
  ) : (
    <span className="text-muted-foreground">Not linked</span>
  )

  const repositoriesDisplay = isPending ? (
    <span className="text-muted-foreground">Loading…</span>
  ) : installation && installation.installationId != null ? (
    <span className="tabular-nums">
      {typeof installation.ingestionRepositoryCount === "number" &&
      Number.isFinite(installation.ingestionRepositoryCount)
        ? String(Math.trunc(installation.ingestionRepositoryCount))
        : "0"}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  )

  return (
    <>
      <article
        id={`connector-github-${connectionId}`}
        className="flex min-h-0 flex-col border border-border bg-transparent px-5 py-4 text-sm"
      >
        <header className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandGithub className="h-4 w-4 text-foreground" />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="font-medium text-foreground">GitHub</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                GitHub App installation for repository access and ingestion.
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
        <div className="mt-5 flex min-h-0 flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-4">
            <div className="min-w-0">
              <dt className="text-sm font-medium text-muted-foreground">
                Account
              </dt>
              <dd className="mt-1 text-sm text-foreground">{accountDisplay}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm font-medium text-muted-foreground">
                Repositories
              </dt>
              <dd className="mt-1 text-sm text-foreground">
                {repositoriesDisplay}
              </dd>
            </div>
          </dl>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {installation?.installationId == null && !isPending ? (
              <Button
                variant="primary"
                className="rounded-none"
                onPress={() => {
                  void navigate({
                    to: "/$orgSlug/repositories/github/setup",
                    params: { orgSlug },
                    search: { returnTo: "connectors" },
                  })
                }}
              >
                Complete GitHub install
              </Button>
            ) : null}
            <Button
              variant="outline"
              className="rounded-none"
              onPress={() => {
                void navigate({
                  to: "/$orgSlug/repositories",
                  params: { orgSlug },
                })
              }}
            >
              Manage repositories
            </Button>
          </div>
        </div>
      </article>

      <Modal isOpen={removeOpen} onOpenChange={setRemoveOpen} isDismissable>
        <AlertDialog
          title="Remove GitHub connector?"
          variant="destructive"
          actionLabel="Remove connector"
          cancelLabel="Cancel"
          onAction={() => removeMutation.mutate()}
        >
          This unlinks the GitHub App installation from ctxpipe. Existing
          repositories stay in ctxpipe, but they will no longer be managed by
          this connector. The GitHub App remains installed in GitHub.
        </AlertDialog>
      </Modal>
    </>
  )
}
