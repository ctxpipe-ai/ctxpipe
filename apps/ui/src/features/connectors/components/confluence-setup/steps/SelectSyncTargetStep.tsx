import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/features/repositories"
import { client } from "@/lib/api"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorConfig,
  patchAtlassianConnectorConfig,
  searchGithubInstallationRepos,
} from "../../../queries/atlassian-connector"

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

type SelectSyncTargetStepProps = {
  orgSlug: string
  atlassianConnectionId?: string
}

export function SelectSyncTargetStep({
  orgSlug,
  atlassianConnectionId,
}: SelectSyncTargetStepProps) {
  const queryClient = useQueryClient()
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [targetInitialized, setTargetInitialized] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => clearTimeout(id)
  }, [repoSearch])

  const { data: orgRepos } = useQuery({
    queryKey: ["repositories", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to fetch repositories")
      const json = (await res.json()) as { items: Repository[] }
      return json.items
    },
  })

  const { data: config } = useQuery({
    queryKey: atlassianConnectorKeys.config(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorConfig(orgSlug, atlassianConnectionId),
    enabled: true,
    throwOnError: false,
  })

  useEffect(() => {
    if (targetInitialized || !config?.syncTarget) return
    const st = config.syncTarget
    const fromOrg = orgRepos?.find((r) => r.id === st.repositoryId)
    setSelectedRepo({
      id: 0,
      full_name: st.repositoryName,
      html_url:
        fromOrg?.gitUrl?.replace(/\.git$/, "") ??
        `https://github.com/${st.repositoryName}`,
      clone_url:
        fromOrg?.gitUrl ?? `https://github.com/${st.repositoryName}.git`,
      name:
        fromOrg?.name ??
        st.repositoryName.split("/").pop() ??
        st.repositoryName,
      default_branch: st.branch,
    })
    setTargetInitialized(true)
  }, [config?.syncTarget, targetInitialized, orgRepos])

  const { data: repoSearchResults, isFetching: isSearchingRepos } = useQuery({
    queryKey: atlassianConnectorKeys.githubRepos(
      orgSlug,
      debouncedRepoSearch,
      undefined,
    ),
    queryFn: () =>
      searchGithubInstallationRepos(orgSlug, debouncedRepoSearch, undefined),
    enabled: true,
  })

  const saveTargetMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRepo) throw new Error("No repository selected")
      const ctxRepo = orgRepos?.find(
        (r) =>
          r.gitUrl === selectedRepo.clone_url ||
          r.name === selectedRepo.name ||
          r.gitUrl.replace(/\.git$/, "") ===
            selectedRepo.clone_url.replace(/\.git$/, ""),
      )
      return patchAtlassianConnectorConfig(
        orgSlug,
        {
          syncTarget: {
            ...(ctxRepo ? { repositoryId: ctxRepo.id } : {}),
            repositoryName: selectedRepo.full_name,
            gitUrl: selectedRepo.clone_url,
            branch: selectedRepo.default_branch,
            enabled: true,
          },
        },
        atlassianConnectionId,
      )
    },
    onSuccess: async (data) => {
      toast.success(
        data.syncEnqueued
          ? "Sync target saved. Full sync has been queued."
          : "Sync target saved.",
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: atlassianConnectorKeys.status(
            orgSlug,
            atlassianConnectionId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: atlassianConnectorKeys.config(
            orgSlug,
            atlassianConnectionId,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: ["repositories", orgSlug],
        }),
      ])
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Select target repository for Confluence content
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Choose the GitHub repository where Confluence content will be synced.
        </p>
      </div>
      <div className="space-y-4">
        <ComboBox
          label="Repository"
          placeholder="Type to search repositories..."
          inputValue={selectedRepo?.full_name ?? repoSearch}
          onInputChange={(value) => {
            setRepoSearch(value)
            if (selectedRepo && value !== selectedRepo.full_name) {
              setSelectedRepo(null)
            }
          }}
          onSelectionChange={(key) => {
            const repo = repoSearchResults?.repositories.find(
              (r) => r.id.toString() === key,
            )
            if (repo) {
              setSelectedRepo(repo)
              setRepoSearch(repo.full_name)
            }
          }}
          items={repoSearchResults?.repositories ?? []}
        >
          {(repo) => (
            <ComboBoxItem id={repo.id.toString()} textValue={repo.full_name}>
              {repo.full_name}
            </ComboBoxItem>
          )}
        </ComboBox>

        {selectedRepo ? (
          <div className="rounded-md bg-zinc-900/50 p-3">
            <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Default branch
            </div>
            <div className="mt-1 text-sm text-zinc-300">
              {selectedRepo.default_branch}
            </div>
          </div>
        ) : null}

        {isSearchingRepos ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Spinner className="size-4" />
            Searching repositories...
          </div>
        ) : null}

        {!isSearchingRepos &&
        debouncedRepoSearch.length > 0 &&
        repoSearchResults?.repositories.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No repositories found. Try a different search, or link more repos
            from the repositories page.
          </p>
        ) : null}

        <Button
          variant="primary"
          isPending={saveTargetMutation.isPending}
          isDisabled={!selectedRepo}
          onPress={() => {
            void saveTargetMutation.mutateAsync()
          }}
        >
          Save sync target
        </Button>
      </div>
    </div>
  )
}
