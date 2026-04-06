import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import {
  GridList,
  GridListItem,
  GridListLoadMoreItem,
} from "@/components/ui/GridList"
import { Radio, RadioGroup } from "@/components/ui/RadioGroup"
import { SearchField } from "@/components/ui/SearchField"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { useCallback, useMemo, useRef, useState } from "react"
import type { Selection } from "react-aria-components"
import { toast } from "sonner"

export const Route = createFileRoute("/$orgSlug/repositories/github/setup")({
  component: GitHubSetupPage,
})

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

type SetupData = {
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  savedRepositories: Array<{ name: string; gitUrl: string }>
}

function GitHubSetupPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()

  const { data: setupData, isPending: setupPending } = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.github.installation.setup.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to fetch setup data")
      return (await res.json()) as SetupData
    },
    enabled: !!session,
  })

  if (sessionPending) return null
  if (!session) {
    return (
      <Navigate
        to="/.auth/sign-in"
        search={{ redirectTo: `/${orgSlug}/repositories/github/setup` }}
        replace
      />
    )
  }

  if (setupPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              Repositories
            </span>
          </header>
          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              GitHub repository setup
            </h1>
            <p className="mt-3 text-sm text-zinc-300">Loading setup…</p>
          </section>
        </main>
      </AppShell>
    )
  }

  return <GitHubSetupForm orgSlug={orgSlug} setupData={setupData ?? undefined} />
}

function GitHubSetupForm({
  orgSlug,
  setupData,
}: {
  orgSlug: string
  setupData?: SetupData
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()

  const savedGitUrls = useMemo(
    () => new Set(setupData?.savedRepositories.map((r) => r.gitUrl)),
    [setupData],
  )

  const [mode, setMode] = useState<"all" | "select">(() =>
    setupData?.ingestAllRepositories === false ? "select" : "all",
  )
  const [includeFutureRepos, setIncludeFutureRepos] = useState(
    () => setupData?.includeFutureRepos ?? false,
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedKeys, setSelectedKeys] = useState<Selection>(new Set())
  const repoMapRef = useRef<Map<number, GitHubRepoItem>>(new Map())
  const initialSelectionApplied = useRef(false)

  const {
    data,
    isPending: reposPending,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["github-installation-repos", orgSlug],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await (
        client[
          ":orgSlug"
        ].api.v1.github.installation.repositories.$get as (arg: {
          param: { orgSlug: string }
          query: { page: string; per_page: string }
        }) => Promise<Response>
      )({
        param: { orgSlug },
        query: { page: String(pageParam), per_page: "30" },
      })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as {
        repositories: GitHubRepoItem[]
        repositorySelection: string
        hasMore: boolean
      }
      for (const repo of json.repositories) {
        repoMapRef.current.set(repo.id, repo)
      }

      if (!initialSelectionApplied.current && savedGitUrls.size > 0) {
        initialSelectionApplied.current = true
        const matched = new Set<number>()
        for (const [id, repo] of repoMapRef.current) {
          if (savedGitUrls.has(repo.clone_url)) matched.add(id)
        }
        if (matched.size > 0) setSelectedKeys(matched as Selection)
      }

      return json
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length + 1 : undefined,
    initialPageParam: 1,
    enabled: !!session,
  })

  const allRepos = useMemo(
    () => data?.pages.flatMap((p) => p.repositories) ?? [],
    [data],
  )
  const repositorySelection = data?.pages[0]?.repositorySelection

  const filteredRepos = useMemo(() => {
    if (!searchQuery) return allRepos
    const q = searchQuery.toLowerCase()
    return allRepos.filter((r) => r.full_name.toLowerCase().includes(q))
  }, [allRepos, searchQuery])

  const handleSelectionChange = useCallback((keys: Selection) => {
    setSelectedKeys(keys)
  }, [])

  const updateOptionsMutation = useMutation({
    mutationFn: async () => {
      if (mode === "all") {
        const res = await client[
          ":orgSlug"
        ].api.v1.github.installation.$patch({
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
      } else {
        const selectedSet =
          selectedKeys === "all"
            ? new Set(allRepos.map((r) => r.id))
            : (selectedKeys as Set<number>)
        const selectedRepositories = Array.from(selectedSet)
          .map((id) => repoMapRef.current.get(Number(id)))
          .filter((r): r is GitHubRepoItem => r != null)
        const res = await client[
          ":orgSlug"
        ].api.v1.github.installation.$patch({
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
      }
    },
    onSuccess: () => {
      toast.success("Repositories saved. Ingestion has started.")
      navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === "select") {
      const count =
        selectedKeys === "all"
          ? allRepos.length
          : (selectedKeys as Set<unknown>).size
      if (count === 0) {
        toast.error("Select at least one repository")
        return
      }
    }
    updateOptionsMutation.mutate()
  }

  return (
    <AppShell>
      <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
        <header className="mb-8">
          <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Repositories
          </span>
        </header>
        <section>
          <h1 className="text-3xl font-medium tracking-tight text-foreground">
            GitHub repository setup
          </h1>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            Choose which repositories to ingest. You can select all or pick
            specific ones.
          </p>
        </section>

        <form
          onSubmit={handleSubmit}
          className="mt-8 space-y-6 rounded-none border border-border bg-card/40 p-6 [&_label]:text-zinc-200!"
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
              <SearchField
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search loaded repositories…"
                aria-label="Search repositories"
                className="[&>div]:rounded-none"
              />

              {reposPending ? (
                <p className="text-sm text-zinc-300">
                  Loading repositories…
                </p>
              ) : allRepos.length === 0 ? (
                <p className="text-sm text-zinc-300">
                  No repositories found for this installation.
                </p>
              ) : (
                <GridList
                  aria-label="Repositories"
                  selectionMode="multiple"
                  selectionBehavior="toggle"
                  selectedKeys={selectedKeys}
                  onSelectionChange={handleSelectionChange}
                  className="max-h-96 rounded-none border border-border bg-card/40"
                >
                  {filteredRepos.map((repo) => (
                    <GridListItem
                      key={repo.id}
                      id={repo.id}
                      textValue={repo.full_name}
                    >
                      <span className="min-w-0 truncate">
                        {repo.full_name}
                      </span>
                    </GridListItem>
                  ))}
                  {hasNextPage && !searchQuery && (
                    <GridListLoadMoreItem
                      onLoadMore={() => {
                        fetchNextPage()
                      }}
                      isLoading={isFetchingNextPage}
                    >
                      {isFetchingNextPage
                        ? "Loading more…"
                        : "Show more"}
                    </GridListLoadMoreItem>
                  )}
                </GridList>
              )}

              {selectedKeys !== "all" &&
                (selectedKeys as Set<unknown>).size > 0 && (
                  <p className="text-sm text-zinc-400">
                    {(selectedKeys as Set<unknown>).size} repositor
                    {(selectedKeys as Set<unknown>).size === 1
                      ? "y"
                      : "ies"}{" "}
                    selected
                  </p>
                )}
              {selectedKeys === "all" && allRepos.length > 0 && (
                <p className="text-sm text-zinc-400">
                  All {allRepos.length} loaded repositories selected
                </p>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <Button
              type="submit"
              variant="primary"
              isDisabled={updateOptionsMutation.isPending}
              className="rounded-none"
            >
              {updateOptionsMutation.isPending
                ? "Saving…"
                : "Save and start ingestion"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="rounded-none"
              onPress={() =>
                navigate({
                  to: "/$orgSlug/repositories",
                  params: { orgSlug },
                })
              }
            >
              Cancel
            </Button>
          </div>
        </form>
      </main>
    </AppShell>
  )
}
