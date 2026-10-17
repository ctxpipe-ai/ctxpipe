import HyperDX from "@hyperdx/browser"
import { IconUnlink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Link } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { GithubRepoPickerList } from "@/features/repositories/components/GithubRepoPickerList"
import { GithubRepoSortSelect } from "@/features/repositories/components/GithubRepoSortSelect"
import {
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import {
  type GithubRepoItem,
  type GithubRepoSort,
  githubInstallationReposOptions,
  sortGithubRepos,
} from "@/features/repositories/githubRepoSelection"
import { gitSourceMatchesQuery } from "@/features/repositories/gitSourcesFilter"
import { eligibleInstallationRepos } from "@/features/workspaces/gitUrl"
import {
  unlinkWorkspaceRepository,
  workspaceKeys,
} from "@/features/workspaces/queries"
import type { WorkspaceLinkedRepository } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import {
  createWorkspaceSource,
  createWorkspaceSourcesBatch,
  deleteWorkspaceSource,
  sourceChangeMessage,
  type WorkspaceSource,
  workspaceSourceKeys,
} from "./queries"
import type { SourceConnectionOption } from "./SourceEditorDialog"
import {
  sourceRowActionsClassName,
  sourceRowClassName,
  sourceRowMetaClassName,
  sourceRowNoteClassName,
  sourceRowSeparatorClassName,
  sourceRowStatusClassName,
  sourceRowsClassName,
} from "./source-table"

/** One item of a GitHub scope: `owner/name`, or a map with a branch or tag. */
type ScopeItem = string | { name: string; ref?: string }

function itemName(item: ScopeItem): string {
  return typeof item === "string" ? item : item.name
}

/**
 * The repositories of a GitHub source. A source file names one `repository`
 * (with an optional `ref`); a legacy `.ctxpipe/sources.yaml` row lists
 * `repositories`.
 */
function scopeItems(source: WorkspaceSource): ScopeItem[] {
  const { repository, ref } = source.scope
  if (typeof repository === "string")
    return [typeof ref === "string" ? { name: repository, ref } : repository]
  const value = source.scope.repositories
  return Array.isArray(value)
    ? value.filter(
        (item): item is ScopeItem =>
          typeof item === "string" ||
          (typeof item === "object" &&
            item !== null &&
            typeof (item as { name?: unknown }).name === "string"),
      )
    : []
}

function scopeRepositories(source: WorkspaceSource): string[] {
  return scopeItems(source).map(itemName)
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

type StatusTag = {
  label: string
  /** What the status means, for the tip on hover and focus. */
  hint: string
  className: string
  dotClassName: string
}

const pendingTag: StatusTag = {
  label: "Pending",
  hint: "ctx| has not read this repository yet.",
  className:
    "inline-flex items-center gap-1.5 rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs text-muted-foreground",
  dotClassName: "size-1.5 rounded-full bg-zinc-500",
}

function linkedStatus(item: WorkspaceLinkedRepository): StatusTag {
  const indexed =
    item.indexedSha != null &&
    item.indexedSha === (item.desiredSha ?? item.indexedSha)
  if (indexed && item.indexingStatus === "complete_with_issues") {
    return {
      label: "Indexed with issues",
      hint: "ctx| indexed the latest commit that it knows, but some parts of the index are incomplete.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200",
      dotClassName: "size-1.5 rounded-full bg-amber-300",
    }
  }
  if (indexed) {
    return {
      label: "Indexed",
      hint: "ctx| indexed the latest commit of this repository that it knows.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200",
      dotClassName: "size-1.5 rounded-full bg-teal-300",
    }
  }
  if (item.desiredSha && item.indexedSha !== item.desiredSha) {
    return {
      label: "Indexing",
      hint: "ctx| knows the latest commit of this repository. It has not indexed that commit yet.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200",
      dotClassName: "size-1.5 animate-pulse rounded-full bg-amber-300",
    }
  }
  return pendingTag
}

/** One row: a linked repository, a source repository, or both. */
export type RepositoryRow = {
  key: string
  title: string
  gitUrl: string
  linked: WorkspaceLinkedRepository | null
  /** The GitHub source that lists the repository, if one does. */
  source: WorkspaceSource | null
}

/** A row needs attention when its index has issues or its source is not ok. */
export function repositoryNeedsAttention(row: RepositoryRow): boolean {
  return (
    row.linked?.indexingStatus === "complete_with_issues" ||
    (row.source != null && row.source.status !== "ok")
  )
}

/** The repository rows of the GitHub section. Rows that need attention come first. */
export function repositoryRows(
  linked: WorkspaceLinkedRepository[],
  sources: WorkspaceSource[],
): RepositoryRow[] {
  const sourceOf = (name: string | null) =>
    name == null
      ? null
      : (sources.find((source) =>
          scopeRepositories(source).some((item) => sameName(item, name)),
        ) ?? null)
  const rows: RepositoryRow[] = linked.map((item) => {
    const name = githubRepoFullNameFromGitUrl(item.gitUrl)
    return {
      key: item.id,
      title: name ?? item.gitUrl,
      gitUrl: item.gitUrl,
      linked: item,
      source: sourceOf(name),
    }
  })
  for (const source of sources) {
    for (const name of scopeRepositories(source)) {
      if (rows.some((row) => sameName(row.title, name))) continue
      rows.push({
        key: `${source.path}:${name}`,
        title: name,
        gitUrl: `https://github.com/${name}.git`,
        linked: null,
        source,
      })
    }
  }
  return rows.sort(
    (a, b) =>
      Number(repositoryNeedsAttention(b)) - Number(repositoryNeedsAttention(a)),
  )
}

/**
 * The GitHub section body of the Workspace sources: one list of the linked
 * repositories. Each GitHub source file under `sources/github/` links one
 * repository; each change goes through that file.
 */
export function GithubSourceRepositories(props: {
  orgSlug: string
  workspaceSlug: string
  workspaceRepositoryUrl: string | null
  rows: RepositoryRow[]
  sources: WorkspaceSource[]
  connections: SourceConnectionOption[]
  canEdit: boolean
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
}) {
  const { orgSlug, workspaceSlug, rows, canEdit } = props
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const filtered = rows.filter((row) =>
    gitSourceMatchesQuery(row.title, row.gitUrl, query),
  )
  // A Workspace can have hundreds of repositories: show the first rows, and
  // all of them in a scroll area on request or while a filter is set.
  const filtering = query.trim() !== ""
  const expanded = showAll || filtering
  const visible = expanded ? filtered : filtered.slice(0, 5)

  const unlinkMutation = useMutation({
    mutationFn: async (row: RepositoryRow) => {
      const { source, linked } = row
      // Without a source row (the file changed since the last projection),
      // the unlink opens a pull request that removes the repository from
      // each file that links it.
      if (!source) {
        if (linked)
          return unlinkWorkspaceRepository(orgSlug, workspaceSlug, linked.id)
        return null
      }
      // One file holds one repository, so an unlink deletes the file. A
      // legacy row has no file that a delete can name.
      if (!source.removable)
        throw new Error(
          "This repository is in .ctxpipe/sources.yaml. Edit that file.",
        )
      return deleteWorkspaceSource(orgSlug, workspaceSlug, source.path)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspaceSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      if (result) toast.success(sourceChangeMessage())
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <>
      {rows.length === 0 ? (
        <p className="border-t border-white/[0.06] px-3 py-2 text-sm text-muted-foreground">
          No GitHub repositories in this Workspace.
        </p>
      ) : (
        <>
          {rows.length > 8 || query !== "" ? (
            <div className="border-t border-white/[0.06] px-3 py-2">
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Filter repositories"
                aria-label="Filter linked repositories"
              />
            </div>
          ) : null}
          <ul
            id={listId}
            aria-label="GitHub repositories"
            className={cn(
              sourceRowsClassName,
              expanded && filtered.length > 5 && "max-h-80 overflow-auto",
            )}
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                No repositories match that filter.
              </li>
            ) : (
              visible.map((row) => {
                const webUrl = githubWebUrl(row.gitUrl)
                const status = row.linked
                  ? linkedStatus(row.linked)
                  : pendingTag
                const canUnlink = row.source
                  ? canEdit && row.source.removable
                  : true
                return (
                  <li key={row.key} className={sourceRowClassName}>
                    {webUrl ? (
                      <Link
                        href={webUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="secondary"
                        className="block min-w-0 truncate text-sm text-foreground no-underline hover:text-teal-300"
                      >
                        {row.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm text-foreground">
                        {row.title}
                      </p>
                    )}
                    <p className={sourceRowMetaClassName}>
                      <span className="truncate">
                        {row.source
                          ? (row.source.connectionName ?? "No connection")
                          : "Linked by a repositories file"}
                      </span>
                      {row.source ? (
                        <>
                          <span
                            aria-hidden
                            className={sourceRowSeparatorClassName}
                          >
                            ·
                          </span>
                          <code className="truncate font-mono">
                            {row.source.path}
                          </code>
                        </>
                      ) : (
                        <span className="hidden @3xl:block" />
                      )}
                    </p>
                    <span className={sourceRowStatusClassName}>
                      <TooltipProvider delay={200}>
                        <Tooltip>
                          {/* The trigger is a button, so keyboard focus opens the tip. */}
                          <TooltipTrigger
                            className={cn(
                              status.className,
                              focusVisibleClassName,
                            )}
                          >
                            <span className={status.dotClassName} aria-hidden />
                            {status.label}
                            {/* Base UI sets no description, so the status carries it. */}
                            <span className="sr-only">{status.hint}</span>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {status.hint}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                    <div className={sourceRowActionsClassName}>
                      {canUnlink ? (
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-label={`Unlink ${row.title}`}
                          isDisabled={unlinkMutation.isPending}
                          onPress={() => unlinkMutation.mutate(row)}
                        >
                          <IconUnlink
                            className="size-4 text-muted-foreground"
                            aria-hidden
                          />
                        </Button>
                      ) : null}
                    </div>
                    {row.source?.description ? (
                      <p
                        className={cn(
                          sourceRowNoteClassName,
                          "line-clamp-2 text-muted-foreground",
                        )}
                      >
                        {row.source.description}
                      </p>
                    ) : null}
                    {row.source && !row.source.removable ? (
                      <p
                        className={cn(
                          sourceRowNoteClassName,
                          "text-muted-foreground",
                        )}
                      >
                        Defined in .ctxpipe/sources.yaml. Edit that file to
                        unlink it.
                      </p>
                    ) : null}
                    {row.linked?.indexingStatus === "complete_with_issues" &&
                    row.linked.indexingError ? (
                      <p
                        className={cn(
                          sourceRowNoteClassName,
                          "text-amber-200/80",
                        )}
                      >
                        {row.linked.indexingError}
                      </p>
                    ) : null}
                  </li>
                )
              })
            )}
          </ul>
          {!filtering && rows.length > 5 ? (
            <div className="border-t border-white/[0.06] px-1 py-1">
              <Button
                variant="quiet"
                className="h-8 px-2 text-xs text-muted-foreground tabular-nums"
                aria-expanded={expanded}
                aria-controls={listId}
                onPress={() => setShowAll(!showAll)}
              >
                {showAll ? "Show fewer" : `Show all ${rows.length}`}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <AddGithubRepositoriesModal
        {...props}
        takenUrls={[
          ...(props.workspaceRepositoryUrl
            ? [props.workspaceRepositoryUrl]
            : []),
          ...rows.map((row) => row.gitUrl),
        ]}
        isOpen={props.addOpen}
        onOpenChange={props.onAddOpenChange}
      />
    </>
  )
}

/**
 * "Add repositories": pick repositories of the GitHub connections. The pick
 * adds to the GitHub source of each connection, or adds a new source.
 */
function AddGithubRepositoriesModal(props: {
  orgSlug: string
  workspaceSlug: string
  connections: SourceConnectionOption[]
  takenUrls: string[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    orgSlug,
    workspaceSlug,
    connections,
    takenUrls,
    isOpen,
    onOpenChange,
  } = props
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState("")
  const [sort, setSort] = useState<GithubRepoSort>("pushed-desc")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  const connectionIds = connections.map((connection) => connection.id)
  const reposQuery = useQuery({
    ...githubInstallationReposOptions(orgSlug, connectionIds),
    enabled: isOpen && connectionIds.length > 0,
  })

  const eligibleRepos = useMemo(
    () =>
      eligibleInstallationRepos({
        // Two connections can list the same repository: give each row its
        // own id for the selection.
        repositories: (reposQuery.data?.repositories ?? []).map(
          (repo, index) => ({ ...repo, id: index + 1 }),
        ),
        takenUrls,
      }),
    [reposQuery.data?.repositories, takenUrls],
  )
  const filteredRepos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const matching = q
      ? eligibleRepos.filter((repo) => repo.full_name.toLowerCase().includes(q))
      : eligibleRepos
    return sortGithubRepos(matching, sort)
  }, [eligibleRepos, searchQuery, sort])
  const selected = eligibleRepos.filter((repo) => selectedIds.has(repo.id))

  const close = () => {
    setSearchQuery("")
    setSelectedIds(new Set())
    onOpenChange(false)
  }

  const addMutation = useMutation({
    mutationFn: async (repos: GithubRepoItem[]) => {
      // One source file for each repository. The server names each file
      // sources/github/<owner>/<name>.md. Several repositories share one
      // request, so they share one pull request (the route takes 20).
      const toInput = (repo: GithubRepoItem) => ({
        provider: "github" as const,
        connectionId: repo.githubConnectionId ?? "",
        scope: { repository: repo.full_name },
      })
      const [only] = repos
      if (repos.length === 1 && only)
        return [
          await createWorkspaceSource(orgSlug, workspaceSlug, toInput(only)),
        ]
      const results = []
      for (let i = 0; i < repos.length; i += 20)
        results.push(
          await createWorkspaceSourcesBatch(
            orgSlug,
            workspaceSlug,
            repos.slice(i, i + 20).map((repo) => ({
              source: toInput(repo),
            })),
          ),
        )
      return results
    },
    onSuccess: (results) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspaceSlug),
      })
      HyperDX.addAction("repository_index_started")
      const first = results[0]
      if (first)
        toast.success(
          results.length > 1
            ? `${results.length} pull requests opened. Each change applies after its merge.`
            : sourceChangeMessage(),
          {
            // Long enough to read the text and to press the action.
            duration: 10_000,
            action: {
              label: "View pull request",
              onClick: () =>
                window.open(first.pullRequestUrl, "_blank", "noopener"),
            },
          },
        )
      close()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const add = () => addMutation.mutate(selected)

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      isDismissable={!addMutation.isPending}
      size="wide"
    >
      <Dialog>
        <Heading
          slot="title"
          className="my-0 text-lg font-medium leading-6 text-foreground"
        >
          Add repositories
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          Select repositories from GitHub. Each repository gets a source file
          under sources/github/ in this Workspace.
        </p>

        <div className="mt-5 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <SearchField
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search repositories"
              aria-label="Search GitHub repositories"
              className="min-w-0 flex-1"
            />
            <GithubRepoSortSelect value={sort} onChange={setSort} />
          </div>
          {connectionIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect GitHub on the Connectors page first.
            </p>
          ) : reposQuery.isPending ? (
            <InlineLoader label="Loading repositories" />
          ) : reposQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Could not load the GitHub repositories.
            </p>
          ) : eligibleRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No installation repositories left to link.
            </p>
          ) : (
            <GithubRepoPickerList
              repos={filteredRepos}
              selectedIds={selectedIds}
              onToggle={(id, isSelected) => {
                setSelectedIds((previous) => {
                  const next = new Set(previous)
                  if (isSelected) next.add(id)
                  else next.delete(id)
                  return next
                })
              }}
              className="rounded-md border-border bg-zinc-900/40"
            />
          )}
          {selected.length > 0 ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {selected.length}{" "}
              {selected.length === 1 ? "repository" : "repositories"} selected
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="quiet"
            isDisabled={addMutation.isPending}
            onPress={close}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={selected.length === 0}
            isPending={addMutation.isPending}
            onPress={() => add()}
          >
            Open a pull request
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
