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
import { cn } from "@/lib/utils"
import {
  createWorkspaceSource,
  deleteWorkspaceSource,
  type SourceDelivery,
  sourceChangeMessage,
  updateWorkspaceSource,
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

function scopeRepositories(source: WorkspaceSource): string[] {
  const value = source.scope.repositories
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : []
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

type StatusTag = { label: string; className: string; dotClassName: string }

const pendingTag: StatusTag = {
  label: "Pending",
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
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200",
      dotClassName: "size-1.5 rounded-full bg-amber-300",
    }
  }
  if (indexed) {
    return {
      label: "Indexed",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200",
      dotClassName: "size-1.5 rounded-full bg-teal-300",
    }
  }
  if (item.desiredSha && item.indexedSha !== item.desiredSha) {
    return {
      label: "Indexing",
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
        key: `${source.sourceKey}:${name}`,
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
 * repositories. Repositories from GitHub sources change through
 * `.ctxpipe/sources.yaml`. Repositories that only an old
 * `repositories/*.md` file links still show, and unlink as before.
 */
export function GithubSourceRepositories(props: {
  orgSlug: string
  workspaceSlug: string
  workspaceRepositoryUrl: string | null
  rows: RepositoryRow[]
  sources: WorkspaceSource[]
  connections: SourceConnectionOption[]
  canEdit: boolean
  directCommitAllowed: boolean
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
}) {
  const { orgSlug, workspaceSlug, rows, canEdit, directCommitAllowed } = props
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
      // A repositories/*.md file can link the repository too. Its unlink
      // deletes that file, and does nothing when no file links it.
      if (linked)
        await unlinkWorkspaceRepository(orgSlug, workspaceSlug, linked.id)
      if (!source) return null
      const delivery: SourceDelivery = directCommitAllowed
        ? "commit"
        : "pull_request"
      const repositories = scopeRepositories(source).filter(
        (name) => !sameName(name, row.title),
      )
      if (repositories.length === 0)
        return deleteWorkspaceSource(
          orgSlug,
          workspaceSlug,
          source.sourceKey,
          delivery,
        )
      if (!source.connectionId)
        throw new Error(
          "This GitHub source has no connection. Edit sources.yaml.",
        )
      return updateWorkspaceSource(
        orgSlug,
        workspaceSlug,
        source.sourceKey,
        {
          provider: "github",
          connectionId: source.connectionId,
          scope: { repositories },
        },
        delivery,
      )
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspaceSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      if (result) toast.success(sourceChangeMessage(result))
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
                const canUnlink = row.source ? canEdit : true
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
                            {row.source.sourceKey}
                          </code>
                        </>
                      ) : (
                        <span className="hidden @3xl:block" />
                      )}
                    </p>
                    <span className={sourceRowStatusClassName}>
                      <span className={status.className}>
                        <span className={status.dotClassName} aria-hidden />
                        {status.label}
                      </span>
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
  sources: WorkspaceSource[]
  connections: SourceConnectionOption[]
  directCommitAllowed: boolean
  takenUrls: string[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    orgSlug,
    workspaceSlug,
    sources,
    connections,
    directCommitAllowed,
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
    mutationFn: async (input: {
      repos: GithubRepoItem[]
      delivery: SourceDelivery
    }) => {
      const results = []
      for (const connectionId of new Set(
        input.repos.map((repo) => repo.githubConnectionId ?? ""),
      )) {
        const names = input.repos
          .filter((repo) => repo.githubConnectionId === connectionId)
          .map((repo) => repo.full_name)
        const existing = sources.find(
          (source) => source.connectionId === connectionId,
        )
        results.push(
          existing
            ? await updateWorkspaceSource(
                orgSlug,
                workspaceSlug,
                existing.sourceKey,
                {
                  provider: "github",
                  connectionId,
                  scope: {
                    repositories: [...scopeRepositories(existing), ...names],
                  },
                },
                input.delivery,
              )
            : await createWorkspaceSource(
                orgSlug,
                workspaceSlug,
                {
                  provider: "github",
                  connectionId,
                  scope: { repositories: names },
                },
                input.delivery,
              ),
        )
      }
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
      if (first) toast.success(sourceChangeMessage(first))
      close()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const add = (delivery: SourceDelivery) =>
    addMutation.mutate({ repos: selected, delivery })

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
          Select repositories from GitHub. The change goes to the sources file
          of this Workspace.
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
          {directCommitAllowed ? (
            <Button
              variant="secondary"
              isDisabled={selected.length === 0 || addMutation.isPending}
              onPress={() => add("commit")}
            >
              Commit directly
            </Button>
          ) : null}
          <Button
            variant="primary"
            isDisabled={selected.length === 0}
            isPending={addMutation.isPending}
            onPress={() => add("pull_request")}
          >
            Open a pull request
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
