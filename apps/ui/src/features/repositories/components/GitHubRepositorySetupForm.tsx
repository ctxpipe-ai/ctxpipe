"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { Radio, RadioGroup } from "@/components/ui/RadioGroup"
import { SearchField } from "@/components/ui/SearchField"
import { Select, SelectItem } from "@/components/ui/Select"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  buildSelectedRepositories,
  collectInstallationRepoPages,
  countSelectionDelta,
  describeSelectionDelta,
  type GithubRepoItem,
  type GithubRepoSort,
  githubCloneUrlKey,
  matchSavedRepoIds,
  selectedCloneUrlKeys,
  sortGithubRepos,
  unmatchedSavedRepos,
} from "../githubRepoSelection"
import { GithubRepoPickerList } from "./GithubRepoPickerList"

export type GitHubRepositorySetupData = {
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  savedRepositories: Array<{ name: string; gitUrl: string }>
}

export type GitHubRepositorySetupFormProps = {
  orgSlug: string
  setupData?: GitHubRepositorySetupData
  /** Affects the small section label above the title (default: repositories). */
  pageContext?: "repositories" | "connectors"
  variant?: "page" | "onboarding"
  onSaveSuccess: () => void
  onCancel: () => void
}

async function fetchInstallationReposPage(
  orgSlug: string,
  page: number,
): Promise<{
  repositories: GithubRepoItem[]
  hasMore: boolean
  repositorySelection: string
}> {
  const res = await (
    client[":orgSlug"].api.v1.github.installation.repositories.$get as (arg: {
      param: { orgSlug: string }
      query: { page: string; per_page: string }
    }) => Promise<Response>
  )({
    param: { orgSlug },
    query: { page: String(page), per_page: "100" },
  })
  if (!res.ok) throw new Error("Failed to fetch repositories")
  return (await res.json()) as {
    repositories: GithubRepoItem[]
    hasMore: boolean
    repositorySelection: string
  }
}

export function GitHubRepositorySetupForm({
  orgSlug,
  setupData,
  pageContext = "repositories",
  variant = "page",
  onSaveSuccess,
  onCancel,
}: GitHubRepositorySetupFormProps) {
  const { data: session } = useSession()
  const queryClient = useQueryClient()

  const contextLabel =
    pageContext === "connectors" ? "Connectors" : "Repositories"

  const savedRepos = setupData?.savedRepositories ?? []
  const savedGitUrls = useMemo(
    () => new Set(savedRepos.map((repo) => repo.gitUrl)),
    [savedRepos],
  )

  const [mode, setMode] = useState<"all" | "select">(() =>
    setupData?.ingestAllRepositories === true ? "all" : "select",
  )
  const [includeFutureRepos, setIncludeFutureRepos] = useState(
    () => setupData?.includeFutureRepos ?? false,
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [sort, setSort] = useState<GithubRepoSort>("pushed-desc")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [selectionHydrated, setSelectionHydrated] = useState(false)

  const {
    data,
    isPending: reposPending,
    isError: reposFailed,
  } = useQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: () =>
      collectInstallationRepoPages((page) =>
        fetchInstallationReposPage(orgSlug, page),
      ),
    enabled: !!session,
  })

  const allRepos = data?.repositories ?? []
  const repositorySelection = data?.repositorySelection

  if (!reposPending && !selectionHydrated && data) {
    setSelectedIds(matchSavedRepoIds(savedGitUrls, allRepos))
    setSelectionHydrated(true)
  }

  const unmatchedSaved = useMemo(
    () => unmatchedSavedRepos(savedRepos, allRepos),
    [savedRepos, allRepos],
  )

  const filteredRepos = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const matchingRepos = q
      ? allRepos.filter((repo) => repo.full_name.toLowerCase().includes(q))
      : allRepos
    return sortGithubRepos(matchingRepos, sort)
  }, [allRepos, searchQuery, sort])

  const handleToggle = (id: number, selected: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectionDelta = useMemo(() => {
    const selectedUrls = selectedCloneUrlKeys(allRepos, selectedIds)
    for (const saved of unmatchedSaved) {
      selectedUrls.add(githubCloneUrlKey(saved.gitUrl))
    }
    return countSelectionDelta({
      savedGitUrls,
      selectedCloneUrls: selectedUrls,
    })
  }, [allRepos, selectedIds, unmatchedSaved, savedGitUrls])

  const patchInstallation = client[":orgSlug"].api.v1.github.installation
    .$patch as (arg: {
    param: { orgSlug: string }
    json: Record<string, unknown>
  }) => Promise<Response>

  const updateOptionsMutation = useMutation({
    mutationFn: async () => {
      if (mode === "all") {
        const res = await patchInstallation({
          param: { orgSlug },
          json: {
            ingestAllRepositories: true,
            includeFutureRepos,
          },
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(err.error ?? "Failed to save")
        }
        return {
          ingestAllRepositories: true,
          includeFutureRepos,
          savedRepositories: setupData?.savedRepositories ?? [],
        } satisfies GitHubRepositorySetupData
      }

      const selectedRepositories = buildSelectedRepositories({
        githubRepos: allRepos,
        selectedIds,
        unmatchedSaved,
      })
      const res = await patchInstallation({
        param: { orgSlug },
        json: {
          ingestAllRepositories: false,
          includeFutureRepos: false,
          selectedRepositories,
        },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(err.error ?? "Failed to save")
      }
      return {
        ingestAllRepositories: false,
        includeFutureRepos: false,
        savedRepositories: selectedRepositories.map((repo) => ({
          name: repo.full_name,
          gitUrl: repo.clone_url,
        })),
      } satisfies GitHubRepositorySetupData
    },
    onSuccess: async (nextSetupData) => {
      queryClient.setQueryData(
        ["github-installation-setup", orgSlug],
        nextSetupData,
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["repositories", orgSlug],
        }),
        queryClient.invalidateQueries({
          queryKey: ["github-installation-repos-preview", orgSlug],
        }),
      ])
      toast.success("Repositories saved. Ingestion has started.")
      onSaveSuccess()
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (mode === "select") {
      const selectedRepositories = buildSelectedRepositories({
        githubRepos: allRepos,
        selectedIds,
        unmatchedSaved,
      })
      if (selectedRepositories.length === 0) {
        toast.error("Select at least one repository")
        return
      }
    }
    updateOptionsMutation.mutate()
  }

  const selectBusy = reposPending || (!selectionHydrated && !reposFailed)

  return (
    <>
      {variant === "page" ? (
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            {contextLabel}
          </span>
        </header>
      ) : null}
      <section className={variant === "onboarding" ? "text-center" : undefined}>
        <h1
          className={
            variant === "onboarding"
              ? "onb-in-1 text-3xl font-semibold text-zinc-100 sm:text-4xl"
              : "text-3xl font-medium tracking-tight text-foreground"
          }
        >
          {variant === "onboarding"
            ? "Choose repositories to index"
            : "GitHub repository setup"}
        </h1>
        <p className="mt-3 text-balance leading-relaxed text-muted-foreground">
          {variant === "onboarding"
            ? "GitHub controls which repositories ctx| can access. Now choose which of those repositories to index into your knowledge graph."
            : "Choose which repositories to ingest. Already indexed repositories stay selected even if you search or have not scrolled the list."}
        </p>
      </section>

      <form
        onSubmit={handleSubmit}
        className="mt-8 space-y-6 rounded-none border border-border bg-card/40 p-6 text-left [&_label]:text-zinc-200!"
      >
        <RadioGroup
          label="Ingestion mode"
          value={mode}
          onChange={(v) => setMode(v as "all" | "select")}
        >
          <Radio value="all">All repositories</Radio>
          <Radio value="select">Select specific repositories</Radio>
        </RadioGroup>

        {mode === "all" && repositorySelection === "all" && (
          <Checkbox
            isSelected={includeFutureRepos}
            onChange={setIncludeFutureRepos}
          >
            Also include repositories added in the future
          </Checkbox>
        )}

        {mode === "select" && (
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row">
              <SearchField
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search repositories"
                aria-label="Search repositories"
                className="min-w-0 flex-1"
              />
              <Select
                aria-label="Sort repositories"
                selectedKey={sort}
                onSelectionChange={(key) => setSort(key as GithubRepoSort)}
                className="shrink-0"
              >
                <SelectItem id="pushed-desc">Recently pushed</SelectItem>
                <SelectItem id="created-desc">Newest created</SelectItem>
                <SelectItem id="created-asc">Oldest created</SelectItem>
                <SelectItem id="name-asc">Name A–Z</SelectItem>
              </Select>
            </div>

            {selectBusy ? (
              <InlineLoader label="Loading repositories" />
            ) : reposFailed ? (
              <p className="text-sm text-zinc-300">
                Failed to load repositories.
              </p>
            ) : allRepos.length === 0 ? (
              <p className="text-sm text-zinc-300">
                No repositories found for this installation.
              </p>
            ) : (
              <GithubRepoPickerList
                repos={filteredRepos}
                selectedIds={selectedIds}
                onToggle={handleToggle}
              />
            )}

            {!selectBusy && !reposFailed && savedRepos.length > 0 ? (
              <p className="text-sm text-zinc-400">
                {describeSelectionDelta(selectionDelta)}
                {unmatchedSaved.length > 0
                  ? ` · keeping ${unmatchedSaved.length} indexed ${
                      unmatchedSaved.length === 1
                        ? "repository"
                        : "repositories"
                    } not in this GitHub list`
                  : null}
              </p>
            ) : !selectBusy && !reposFailed && selectedIds.size > 0 ? (
              <p className="text-sm text-zinc-400">
                {selectedIds.size}{" "}
                {selectedIds.size === 1 ? "repository" : "repositories"}{" "}
                selected
              </p>
            ) : null}
          </div>
        )}

        <div className="flex gap-3">
          <Button
            type="submit"
            variant="primary"
            isDisabled={
              updateOptionsMutation.isPending ||
              selectBusy ||
              (mode === "select" && reposFailed)
            }
            className="rounded-none"
          >
            {updateOptionsMutation.isPending
              ? "Saving…"
              : variant === "onboarding"
                ? "Save and continue"
                : "Save and start ingestion"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-none"
            onPress={onCancel}
          >
            {variant === "onboarding" ? "Skip for now" : "Cancel"}
          </Button>
        </div>
      </form>
    </>
  )
}
