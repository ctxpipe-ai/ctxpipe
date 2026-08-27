import { IconGitBranch, IconPlus, IconUnlink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { TextField } from "@/components/ui/TextField"
import { GithubRepoPickerList } from "@/features/repositories/components/GithubRepoPickerList"
import {
  githubRepoFullNameFromGitUrl,
  githubWebUrl,
} from "@/features/repositories/github-web-url"
import {
  collectInstallationRepoPages,
  fetchGithubInstallationReposPage,
} from "@/features/repositories/githubRepoSelection"
import { gitSourceMatchesQuery } from "@/features/repositories/gitSourcesFilter"
import { cn } from "@/lib/utils"
import { eligibleInstallationRepos } from "./gitUrl"
import {
  linkWorkspaceRepository,
  unlinkWorkspaceRepository,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail, WorkspaceLinkedRepository } from "./types"

function repoTitle(gitUrl: string): string {
  return githubRepoFullNameFromGitUrl(gitUrl) ?? gitUrl
}

function linkedStatus(item: WorkspaceLinkedRepository): {
  label: string
  className: string
  dotClassName: string
} {
  const indexed =
    item.indexedSha != null &&
    item.indexedSha === (item.desiredSha ?? item.indexedSha)
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
  return {
    label: "Pending",
    className:
      "inline-flex items-center gap-1.5 rounded-md border border-border bg-zinc-800 px-2 py-0.5 text-xs text-muted-foreground",
    dotClassName: "size-1.5 rounded-full bg-zinc-500",
  }
}

export function WorkspaceLinkedRepositories(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [addOpen, setAddOpen] = useState(false)

  const linked = workspace.linkedRepositories
  const filtered = useMemo(() => {
    return linked.filter((item) =>
      gitSourceMatchesQuery(repoTitle(item.gitUrl), item.gitUrl, query),
    )
  }, [linked, query])

  const unlinkMutation = useMutation({
    mutationFn: (linkedId: string) =>
      unlinkWorkspaceRepository(orgSlug, workspace.slug, linkedId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const isEmpty = linked.length === 0

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">
            Linked repositories
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Extra remotes for codesearch.
          </p>
        </div>
        {isEmpty ? null : (
          <Button variant="secondary" onPress={() => setAddOpen(true)}>
            <IconPlus className="size-4" aria-hidden />
            Add
          </Button>
        )}
      </div>

      {isEmpty ? (
        <div className="mt-4 flex max-w-md flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            No extra repositories linked yet.
          </p>
          <div>
            <Button variant="primary" onPress={() => setAddOpen(true)}>
              <IconPlus className="size-4" aria-hidden />
              Add repositories
            </Button>
          </div>
        </div>
      ) : (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Filter repositories"
            aria-label="Filter linked repositories"
            className="mt-4 max-w-md"
          />
          <ul className="mt-3 flex flex-col gap-1">
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-sm text-muted-foreground">
                No repositories match that filter.
              </li>
            ) : (
              filtered.map((item) => {
                const title = repoTitle(item.gitUrl)
                const webUrl = githubWebUrl(item.gitUrl)
                const status = linkedStatus(item)
                return (
                  <li key={item.id}>
                    <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/[0.04]">
                      <span
                        className="ctx-node size-8 shrink-0 rounded-md text-muted-foreground"
                        aria-hidden
                      >
                        <IconGitBranch className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          {title}
                        </p>
                        {webUrl ? (
                          <a
                            href={webUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-xs text-muted-foreground hover:text-foreground"
                          >
                            {item.gitUrl}
                          </a>
                        ) : (
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {item.gitUrl}
                          </p>
                        )}
                      </div>
                      <span className={cn("shrink-0", status.className)}>
                        <span className={status.dotClassName} aria-hidden />
                        {status.label}
                      </span>
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        aria-label={`Unlink ${title}`}
                        isDisabled={unlinkMutation.isPending}
                        onPress={() => unlinkMutation.mutate(item.id)}
                      >
                        <IconUnlink
                          className="size-4 text-muted-foreground"
                          aria-hidden
                        />
                      </Button>
                    </div>
                  </li>
                )
              })
            )}
          </ul>
        </>
      )}

      <AddLinkedReposModal
        orgSlug={orgSlug}
        workspace={workspace}
        isOpen={addOpen}
        onOpenChange={setAddOpen}
      />
    </section>
  )
}

function AddLinkedReposModal(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { orgSlug, workspace, isOpen, onOpenChange } = props
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [pasteUrl, setPasteUrl] = useState("")

  const takenUrls = useMemo(
    () => [
      workspace.workspaceRepositoryUrl,
      ...workspace.linkedRepositories.map((item) => item.gitUrl),
    ],
    [workspace.linkedRepositories, workspace.workspaceRepositoryUrl],
  )

  const reposQuery = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: () =>
      collectInstallationRepoPages((page) =>
        fetchGithubInstallationReposPage(orgSlug, page),
      ),
    enabled: isOpen,
  })

  const eligibleRepos = useMemo(
    () =>
      eligibleInstallationRepos({
        repositories: reposQuery.data?.repositories ?? [],
        takenUrls,
      }),
    [reposQuery.data?.repositories, takenUrls],
  )

  const filteredRepos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return eligibleRepos
    return eligibleRepos.filter((repo) =>
      (repo.full_name ?? repo.name).toLowerCase().includes(q),
    )
  }, [eligibleRepos, searchQuery])

  const reset = () => {
    setSearchQuery("")
    setSelectedIds(new Set())
    setPasteUrl("")
  }

  const linkMutation = useMutation({
    mutationFn: async (urls: string[]) => {
      for (const gitUrl of urls) {
        await linkWorkspaceRepository(orgSlug, workspace.slug, gitUrl)
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      toast.success("Repositories linked")
      reset()
      onOpenChange(false)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const selectedUrls = eligibleRepos
    .filter((repo) => selectedIds.has(repo.id))
    .map((repo) => repo.clone_url)
  const paste = pasteUrl.trim()
  const canLink = selectedUrls.length > 0 || paste.length > 0

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        onOpenChange(open)
        if (!open) reset()
      }}
      isDismissable={!linkMutation.isPending}
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
          Select from GitHub, or paste a git URL.
        </p>

        <div className="mt-5 space-y-3">
          <SearchField
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search repositories"
            aria-label="Search GitHub repositories"
          />
          {reposQuery.isPending ? (
            <InlineLoader label="Loading repositories" />
          ) : reposQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Couldn’t load GitHub repositories. Connect GitHub under
              Connectors, or paste a git URL.
            </p>
          ) : eligibleRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No installation repositories left to link.
            </p>
          ) : (
            <GithubRepoPickerList
              repos={filteredRepos}
              selectedIds={selectedIds}
              onToggle={(id, selected) => {
                setSelectedIds((previous) => {
                  const next = new Set(previous)
                  if (selected) next.add(id)
                  else next.delete(id)
                  return next
                })
              }}
              className="rounded-md border-border bg-zinc-900/40"
            />
          )}
          {selectedUrls.length > 0 ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {selectedUrls.length}{" "}
              {selectedUrls.length === 1 ? "repository" : "repositories"}{" "}
              selected
            </p>
          ) : null}
        </div>

        <TextField
          className="mt-5"
          label="Git URL"
          value={pasteUrl}
          onChange={setPasteUrl}
          placeholder="https://github.com/org/repo.git"
        />

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="quiet"
            isDisabled={linkMutation.isPending}
            onPress={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={linkMutation.isPending || !canLink}
            onPress={() => {
              const urls = [...selectedUrls]
              if (paste) urls.push(paste)
              linkMutation.mutate(urls)
            }}
          >
            Link
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
