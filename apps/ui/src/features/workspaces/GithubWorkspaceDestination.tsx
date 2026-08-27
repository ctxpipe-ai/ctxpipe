"use client"

import { IconFolder, IconPlus } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Button as RACButton } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SkeletonRow } from "@/components/ui/Skeleton"
import { githubRepoFullNameFromGitUrl } from "@/features/repositories/github-web-url"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { workspaceListOptions } from "./queries"
import type { Workspace } from "./types"

export type GithubWorkspaceDestinationProps = {
  variant?: "page" | "onboarding"
  status: "loading" | "error" | "ready"
  workspaces: Workspace[]
  onCreateWorkspace: () => void
  onSelectWorkspace: (workspace: Workspace) => void
  onClose: () => void
  onRetry?: () => void
}

function workspaceRepoLine(workspace: Workspace): string {
  return (
    githubRepoFullNameFromGitUrl(workspace.workspaceRepositoryUrl) ??
    workspace.workspaceRepositoryUrl
  )
}

export function GithubWorkspaceDestination({
  variant = "page",
  status,
  workspaces,
  onCreateWorkspace,
  onSelectWorkspace,
  onClose,
  onRetry,
}: GithubWorkspaceDestinationProps) {
  const onboarding = variant === "onboarding"
  const empty = status === "ready" && workspaces.length === 0

  return (
    <div className={cn("w-full", onboarding && "mx-auto max-w-2xl text-left")}>
      {variant === "page" ? (
        <header className="mb-8">
          <span className="ctx-label text-teal-400">GitHub</span>
        </header>
      ) : null}

      <h1
        className={
          onboarding
            ? "onb-in-1 text-3xl font-semibold text-zinc-100 sm:text-4xl"
            : "text-xl font-medium tracking-tight text-foreground"
        }
      >
        GitHub is connected
      </h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
        {empty
          ? "Create a workspace to add repositories, or close the wizard."
          : "Create a new workspace, add repositories to an existing one, or close the wizard."}
      </p>

      {status === "loading" ? (
        <div className="mt-8 space-y-6">
          <div aria-busy>
            <span className="sr-only">Loading workspaces</span>
            <SkeletonRow size="catalog" lines={2} />
            <SkeletonRow size="catalog" lines={2} />
            <SkeletonRow size="catalog" lines={2} />
          </div>
          <Button variant="quiet" onPress={onClose}>
            Close wizard
          </Button>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="mt-8 space-y-6">
          <InlineAlert
            variant="error"
            title="Could not load workspaces"
            actions={
              onRetry ? (
                <Button
                  variant="outline"
                  className="rounded-md"
                  onPress={onRetry}
                >
                  Retry
                </Button>
              ) : null
            }
          >
            Try again, or close the wizard and open a workspace from the
            sidebar.
          </InlineAlert>
          <Button variant="quiet" onPress={onClose}>
            Close wizard
          </Button>
        </div>
      ) : null}

      {status === "ready" && empty ? (
        <div className="mt-8 flex flex-col items-start gap-4">
          <Button variant="primary" onPress={onCreateWorkspace}>
            <IconPlus className="size-4 text-current" aria-hidden />
            Create workspace
          </Button>
          <Button variant="quiet" onPress={onClose}>
            Close wizard
          </Button>
        </div>
      ) : null}

      {status === "ready" && workspaces.length > 0 ? (
        <div className="mt-8 space-y-6">
          <Button
            variant="outline"
            className="rounded-md"
            onPress={onCreateWorkspace}
          >
            <IconPlus className="size-4 text-current" aria-hidden />
            Create workspace
          </Button>

          <ul className="space-y-2" aria-label="Existing workspaces">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <RACButton
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md border border-border bg-card/40 p-4 text-left transition-colors",
                    "hover:border-teal-400/40 hover:bg-foreground/[0.03]",
                    focusVisibleClassName,
                  )}
                  onPress={() => onSelectWorkspace(workspace)}
                >
                  <span className="ctx-node size-9 shrink-0" aria-hidden>
                    <IconFolder
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {workspace.displayName}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {workspaceRepoLine(workspace)}
                    </span>
                  </span>
                </RACButton>
              </li>
            ))}
          </ul>

          <Button variant="quiet" onPress={onClose}>
            Close wizard
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function GithubWorkspaceDestinationFromApi(props: {
  orgSlug: string
  variant?: "page" | "onboarding"
  onCreateWorkspace: () => void
  onSelectWorkspace: (workspace: Workspace) => void
  onClose: () => void
}) {
  const { orgSlug, variant, onCreateWorkspace, onSelectWorkspace, onClose } =
    props
  const listQuery = useQuery(workspaceListOptions(orgSlug))

  const status = listQuery.isError
    ? "error"
    : listQuery.isPending
      ? "loading"
      : "ready"

  return (
    <GithubWorkspaceDestination
      variant={variant}
      status={status}
      workspaces={listQuery.data?.items ?? []}
      onCreateWorkspace={onCreateWorkspace}
      onSelectWorkspace={onSelectWorkspace}
      onClose={onClose}
      onRetry={() => void listQuery.refetch()}
    />
  )
}
