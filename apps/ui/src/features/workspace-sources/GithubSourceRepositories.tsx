import HyperDX from "@hyperdx/browser"
import { IconExternalLink, IconPlus, IconUnlink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useId, useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Link } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/Tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"
import { orgConnectionsOptions } from "@/features/connectors/queries/org-connections"
import { GithubRepoPickerList } from "@/features/repositories/components/GithubRepoPickerList"
import { GithubRepoSortSelect } from "@/features/repositories/components/GithubRepoSortSelect"
import {
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import {
  type GithubRepoItem,
  type GithubRepoSort,
  githubCloneUrlKey,
  githubInstallationReposOptions,
  sortGithubRepos,
} from "@/features/repositories/githubRepoSelection"
import { gitSourceMatchesQuery } from "@/features/repositories/gitSourcesFilter"
import { workspaceUpgradesOptions } from "@/features/workspace-upgrades/queries"
import { eligibleInstallationRepos } from "@/features/workspaces/gitUrl"
import {
  unlinkWorkspaceRepository,
  workspaceDetailOptions,
  workspaceKeys,
} from "@/features/workspaces/queries"
import type { WorkspaceLinkedRepository } from "@/features/workspaces/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useIsOrgAdmin } from "@/lib/org-member-role"
import { cn } from "@/lib/utils"

import { addRepositoriesGate } from "./add-repositories-gate"
import { AddRepositoryByUrlForm } from "./AddRepositoryByUrl"
import {
  createWorkspaceSource,
  createWorkspaceSourcesBatch,
  deleteWorkspaceSource,
  sourceChangeMessage,
  type WorkspaceSource,
  workspaceSourceKeys,
  workspaceSourcesOptions,
} from "./queries"
import {
  sourceRowActionsClassName,
  sourceRowClassName,
  sourceRowMetaClassName,
  sourceRowNoteClassName,
  sourceRowSeparatorClassName,
  sourceRowStatusClassName,
  sourceRowsClassName,
} from "./source-table"
import { CompactSourceRow, type SourceLiveStatus } from "./SourceLiveStatusCell"

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
  hint: "ctxpipe has not read this repository yet.",
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
      hint: "ctxpipe indexed the latest commit that it knows, but some parts of the index are incomplete.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200",
      dotClassName: "size-1.5 rounded-full bg-amber-300",
    }
  }
  if (indexed) {
    return {
      label: "Indexed",
      hint: "ctxpipe indexed the latest commit of this repository that it knows.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200",
      dotClassName: "size-1.5 rounded-full bg-teal-300",
    }
  }
  if (item.desiredSha && item.indexedSha !== item.desiredSha) {
    return {
      label: "Indexing",
      hint: "ctxpipe knows the latest commit of this repository. It has not indexed that commit yet.",
      className:
        "inline-flex items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200",
      dotClassName: "size-1.5 animate-pulse rounded-full bg-amber-300",
    }
  }
  return pendingTag
}

/** One row: a linked repository, a source repository, or both. */
type RepositoryRow = {
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
  rows: RepositoryRow[]
  canEdit: boolean
  /** No repository and no pending add: the body shows the primary add button. */
  showEmptyAction: boolean
  /** Opens the Add repositories dialog, which the caller renders. */
  onAdd: () => void
  /** PROTOTYPE (variant D): the live work of a repository, by its title. */
  liveStatus?: (title: string) => SourceLiveStatus | null
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
        props.showEmptyAction ? (
          <div className="flex flex-col items-start gap-3 border-t border-white/[0.06] px-3 py-3">
            <p className="text-sm text-muted-foreground">
              Add the code repositories of this Workspace. ctxpipe reads them to
              answer questions.
            </p>
            <Button variant="primary" onPress={props.onAdd}>
              <IconPlus className="size-4" aria-hidden />
              Add repositories
            </Button>
          </div>
        ) : (
          <p className="border-t border-white/[0.06] px-3 py-2 text-sm text-muted-foreground">
            No GitHub repositories in this Workspace.
          </p>
        )
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
                // PROTOTYPE (variant D): a two-line row with one status line.
                if (props.liveStatus) {
                  const notes = [
                    row.source?.description ? (
                      <p
                        key="description"
                        className="line-clamp-2 text-muted-foreground"
                      >
                        {row.source.description}
                      </p>
                    ) : null,
                    row.source && !row.source.removable ? (
                      <p key="yaml" className="text-muted-foreground">
                        Defined in .ctxpipe/sources.yaml. Edit that file to
                        unlink it.
                      </p>
                    ) : null,
                    row.linked?.indexingStatus === "complete_with_issues" &&
                    row.linked.indexingError ? (
                      <p key="issues" className="text-amber-200/80">
                        {row.linked.indexingError}
                      </p>
                    ) : null,
                  ].filter(Boolean)
                  return (
                    <CompactSourceRow
                      key={row.key}
                      name={row.title}
                      title={
                        webUrl ? (
                          <Link
                            href={webUrl}
                            target="_blank"
                            rel="noreferrer"
                            variant="secondary"
                            className="text-sm text-foreground no-underline hover:text-teal-300"
                          >
                            {row.title}
                          </Link>
                        ) : (
                          row.title
                        )
                      }
                      subtitle={
                        row.source?.path ?? "Linked by a repositories file"
                      }
                      state={{
                        label: status.label,
                        tone:
                          status.label === "Indexed"
                            ? "ok"
                            : status.label === "Indexed with issues"
                              ? "attention"
                              : "neutral",
                      }}
                      live={props.liveStatus(row.title)}
                      actions={
                        canUnlink
                          ? [
                              {
                                id: "unlink",
                                label: "Unlink",
                                onAction: () => unlinkMutation.mutate(row),
                                isDisabled: unlinkMutation.isPending,
                              },
                            ]
                          : []
                      }
                      {...(notes.length ? { note: <>{notes}</> } : {})}
                    />
                  )
                }
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
    </>
  )
}

/**
 * The repository that a row names, for the selection: the connection that
 * lists it and its clone URL. A list that loads again can move a repository
 * to another place, so the selection never uses the place.
 */
function pickKey(repo: GithubRepoItem): string {
  return `${repo.githubConnectionId ?? ""} ${githubCloneUrlKey(repo.clone_url)}`
}

/**
 * "Add repositories": pick repositories of the GitHub connections. Each pick
 * adds one GitHub source file. The Workspace repository shows, but the user
 * cannot pick it: a Workspace cannot link its own repository. The dialog
 * reads the same queries as the Sources section, so the Sources section and
 * the Get started guide on Home both render it and show the same list. A
 * Workspace that is read-only or below format 2 gets the reason and the next
 * step in place of the list.
 */
export function WorkspaceAddRepositoriesDialog(props: {
  orgSlug: string
  workspaceSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { orgSlug, workspaceSlug, isOpen, onOpenChange } = props
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [sort, setSort] = useState<GithubRepoSort>("pushed-desc")
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<"select" | "paste">("select")

  // Only an owner or admin can list the installation repositories.
  const isAdmin = useIsOrgAdmin(orgSlug)
  const detailQuery = useQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    enabled: isOpen,
  })
  const sourcesQuery = useQuery({
    ...workspaceSourcesOptions(orgSlug, workspaceSlug),
    enabled: isOpen,
  })
  const connectionsQuery = useQuery({
    ...orgConnectionsOptions(orgSlug),
    enabled: isOpen,
  })
  const upgradesQuery = useQuery({
    ...workspaceUpgradesOptions(orgSlug, workspaceSlug),
    enabled: isOpen && isAdmin === true,
  })
  const connections = (connectionsQuery.data ?? [])
    .filter((connection) => connection.type === "github")
    .map(({ id, displayName }) => ({ id, displayName }))
  const connectionIds = connections.map((connection) => connection.id)
  const reposQuery = useQuery({
    ...githubInstallationReposOptions(orgSlug, connectionIds),
    enabled: isOpen && connectionIds.length > 0 && isAdmin === true,
    // The user can give access on GitHub in another tab. The list then
    // loads again when the user comes back to this tab, at most every 10 s.
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })

  const pending =
    detailQuery.isPending ||
    sourcesQuery.isPending ||
    connectionsQuery.isPending ||
    upgradesQuery.isPending
  const failed = detailQuery.isError
    ? detailQuery
    : sourcesQuery.isError
      ? sourcesQuery
      : upgradesQuery.isError
        ? upgradesQuery
        : connectionsQuery.isError
          ? connectionsQuery
          : null
  const gate =
    detailQuery.data && sourcesQuery.data && upgradesQuery.data
      ? addRepositoriesGate({
          canEdit: sourcesQuery.data.canEdit,
          readOnlyReason: detailQuery.data.readOnlyReason,
          formatVersion: upgradesQuery.data.formatVersion,
          codeFormat: upgradesQuery.data.codeFormat,
        })
      : null
  const showPicker = isAdmin === true && !pending && !failed && !gate

  const workspaceRepositoryUrl = detailQuery.data?.workspaceRepositoryUrl
  const rows = repositoryRows(
    detailQuery.data?.linkedRepositories ?? [],
    (sourcesQuery.data?.items ?? []).filter(
      (item) => item.provider === "github",
    ),
  )
  const eligibleRepos = eligibleInstallationRepos({
    // Two connections can list the same repository: give each row its own
    // id for the list.
    repositories: (reposQuery.data?.repositories ?? []).map((repo, index) => ({
      ...repo,
      id: index + 1,
    })),
    takenUrls: rows.map((row) => row.gitUrl),
  })
  const disabledLabels = new Map<number, string>(
    workspaceRepositoryUrl
      ? eligibleRepos
          .filter(
            (repo) =>
              githubCloneUrlKey(repo.clone_url) ===
              githubCloneUrlKey(workspaceRepositoryUrl),
          )
          .map((repo): [number, string] => [
            repo.id,
            "This Workspace's repository",
          ])
      : [],
  )
  const query = searchQuery.trim().toLowerCase()
  const filteredRepos = sortGithubRepos(
    query
      ? eligibleRepos.filter((repo) =>
          repo.full_name.toLowerCase().includes(query),
        )
      : eligibleRepos,
    sort,
  )
  const selected = eligibleRepos.filter((repo) =>
    selectedKeys.has(pickKey(repo)),
  )
  const accessLinks = (reposQuery.data?.manageUrls ?? []).map(
    ({ connectionId, url }) => ({
      url,
      name:
        connections.find((connection) => connection.id === connectionId)
          ?.displayName ?? "GitHub",
    }),
  )

  const close = () => {
    setSearchQuery("")
    setSelectedKeys(new Set())
    setMode("select")
    onOpenChange(false)
  }

  /** After an add: load the sources again, say where the change is, and close. */
  const added = (results: ReadonlyArray<{ pullRequestUrl: string }>) => {
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
    onSuccess: added,
    onError: (error: Error) => toast.error(error.message),
  })

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
        <div className="mt-1 max-w-prose space-y-1 text-sm text-muted-foreground">
          <p>
            ctxpipe reads the default branch of each repository. It uses the
            code to answer questions and to keep this Workspace current.
          </p>
          <p>
            <strong className="font-medium text-foreground">
              Open a pull request
            </strong>{" "}
            adds one file for each repository under{" "}
            <code className="font-mono text-xs">sources/</code> in the Workspace
            repository. Each repository becomes active when you merge the pull
            request that adds it.
          </p>
        </div>

        <div className="mt-5 space-y-3">
          {isAdmin === false ? (
            <p className="text-sm text-muted-foreground">
              Ask an admin to add repositories. Only an owner or admin can list
              the GitHub repositories.
            </p>
          ) : pending ? (
            <InlineLoader label="Loading repositories" />
          ) : failed ? (
            <InlineAlert
              variant="error"
              title="Could not load the Workspace"
              actions={
                <Button
                  variant="secondary"
                  onPress={() => void failed.refetch()}
                >
                  Retry
                </Button>
              }
            >
              Try again, or open the Workspace and add repositories in Settings.
            </InlineAlert>
          ) : gate ? (
            <InlineAlert
              variant="warning"
              title={gate.title}
              actions={
                <Button
                  variant="secondary"
                  onPress={() => {
                    close()
                    void navigate({
                      to: "/$orgSlug/ws/$workspaceSlug",
                      params: { orgSlug, workspaceSlug },
                      search: { pane: "settings" },
                    })
                  }}
                >
                  {gate.action}
                </Button>
              }
            >
              {gate.body}
            </InlineAlert>
          ) : (
            <Tabs
              selectedKey={mode}
              onSelectionChange={(key) => {
                if (key === "select" || key === "paste") setMode(key)
              }}
              className="gap-3"
            >
              <TabList
                aria-label="How to add repositories"
                className="m-0 self-start rounded-md bg-zinc-800 p-1"
              >
                <Tab id="select">Select GitHub</Tab>
                <Tab id="paste">Paste URL</Tab>
              </TabList>
              <TabPanel id="select" className="space-y-3 p-0">
                {connectionIds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    <Link href={`/${orgSlug}/connectors`}>
                      Connect GitHub on the Connectors page first.
                    </Link>
                  </p>
                ) : (
                  <>
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
                    {reposQuery.isPending ? (
                      <InlineLoader label="Loading repositories" />
                    ) : reposQuery.isError ? (
                      <p className="text-sm text-muted-foreground">
                        Could not load the GitHub repositories.
                      </p>
                    ) : eligibleRepos.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No installation repositories left to link.
                      </p>
                    ) : filteredRepos.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No repositories match that search.
                      </p>
                    ) : (
                      <GithubRepoPickerList
                        repos={filteredRepos}
                        disabledLabels={disabledLabels}
                        selectedIds={new Set(selected.map((repo) => repo.id))}
                        onToggle={(id, isSelected) => {
                          const repo = eligibleRepos.find(
                            (item) => item.id === id,
                          )
                          if (!repo) return
                          setSelectedKeys((previous) => {
                            const next = new Set(previous)
                            if (isSelected) next.add(pickKey(repo))
                            else next.delete(pickKey(repo))
                            return next
                          })
                        }}
                        className="rounded-md border-border bg-zinc-900/40"
                      />
                    )}
                    {reposQuery.isPending ? null : (
                      <div className="space-y-1 text-sm text-muted-foreground">
                        {accessLinks.length === 0 ? (
                          <p>
                            Don't see a repository?{" "}
                            <Link href={`/${orgSlug}/connectors`}>
                              Check the GitHub connection on the Connectors page
                            </Link>
                            .
                          </p>
                        ) : accessLinks.length === 1 ? (
                          <p>
                            Don't see a repository?{" "}
                            <Link
                              href={accessLinks[0]?.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1"
                            >
                              Give ctxpipe access on GitHub
                              <IconExternalLink
                                className="size-3.5"
                                aria-hidden
                              />
                            </Link>
                            .
                          </p>
                        ) : (
                          <>
                            <p>
                              Don't see a repository? Give ctxpipe access on
                              GitHub.
                            </p>
                            <ul className="m-0 list-none space-y-0.5 p-0">
                              {accessLinks.map((link) => (
                                <li key={link.url}>
                                  <Link
                                    href={link.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1"
                                  >
                                    Give ctxpipe access for {link.name}
                                    <IconExternalLink
                                      className="size-3.5"
                                      aria-hidden
                                    />
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <p>
                          Only an owner of the GitHub organization can give
                          access. If you are not an owner, ask one to do it.
                        </p>
                      </div>
                    )}
                    {selected.length > 0 ? (
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {selected.length}{" "}
                        {selected.length === 1 ? "repository" : "repositories"}{" "}
                        selected
                      </p>
                    ) : null}
                  </>
                )}
              </TabPanel>
              <TabPanel id="paste" className="p-0">
                <AddRepositoryByUrlForm
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  onAdded={(result) => added([result])}
                  onCancel={close}
                />
              </TabPanel>
            </Tabs>
          )}
        </div>

        {/* The Paste URL form has its own buttons. */}
        {showPicker && mode === "paste" ? null : (
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="quiet"
              isDisabled={addMutation.isPending}
              onPress={close}
            >
              Cancel
            </Button>
            {showPicker && connectionIds.length > 0 ? (
              <Button
                variant="primary"
                isDisabled={selected.length === 0}
                isPending={addMutation.isPending}
                onPress={() => addMutation.mutate(selected)}
              >
                Open a pull request
              </Button>
            ) : null}
          </div>
        )}
      </Dialog>
    </Modal>
  )
}
