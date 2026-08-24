import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import type { Repository } from "@/features/repositories"
import { GithubRepoPickerSkeleton } from "@/features/repositories/components/GithubRepoPickerList"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import {
  atlassianConnectorKeys,
  fetchAtlassianConnectorConfig,
  patchAtlassianConnectorConfig,
  searchGithubInstallationRepos,
} from "../../../queries/atlassian-connector"
import {
  connectorSyncTargetKeys,
  fetchSuggestedConnectorSyncTarget,
} from "../../../queries/connector-sync-target"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "../../../queries/github-connector"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  ConnectorContextRepositoryGuidance,
  getConnectorContextRepositoryCreateUrl,
} from "../../ConnectorContextRepositoryGuidance"

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
      const json = await readApiJson<{ items: Repository[] }>(res, {
        message: "Failed to fetch repositories",
      })
      return json.items
    },
  })

  const { data: githubInstallation } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
  })

  const { data: config } = useQuery({
    queryKey: atlassianConnectorKeys.config(orgSlug, atlassianConnectionId),
    queryFn: () =>
      fetchAtlassianConnectorConfig(orgSlug, atlassianConnectionId),
    enabled: true,
    throwOnError: false,
  })

  const suggestedTargetQuery = useQuery({
    queryKey: connectorSyncTargetKeys.suggestion(orgSlug),
    queryFn: () => fetchSuggestedConnectorSyncTarget(orgSlug),
  })

  useEffect(() => {
    if (
      targetInitialized ||
      config === undefined ||
      suggestedTargetQuery.isPending
    )
      return
    if (config?.syncTarget) {
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
    } else if (suggestedTargetQuery.data) {
      const suggested = suggestedTargetQuery.data
      setSelectedRepo({
        id: 0,
        full_name: suggested.repositoryName,
        html_url: suggested.gitUrl.replace(/\.git$/, ""),
        clone_url: suggested.gitUrl,
        name:
          suggested.repositoryName.split("/").pop() ?? suggested.repositoryName,
        default_branch: suggested.branch,
      })
    }
    setTargetInitialized(true)
  }, [
    config,
    orgRepos,
    suggestedTargetQuery.data,
    suggestedTargetQuery.isPending,
    targetInitialized,
  ])

  const {
    data: repoSearchResults,
    isFetching: isSearchingRepos,
    refetch: refetchRepositories,
  } = useQuery({
    queryKey: atlassianConnectorKeys.githubRepos(
      orgSlug,
      debouncedRepoSearch,
      undefined,
    ),
    queryFn: () =>
      searchGithubInstallationRepos(orgSlug, debouncedRepoSearch, undefined),
    enabled: true,
    refetchOnWindowFocus: "always",
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
        data.configPrEnqueued
          ? "Sync target saved. A pull request for confluence/config.yaml is being created."
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
  const createRepositoryUrl = getConnectorContextRepositoryCreateUrl(
    githubInstallation?.accountSlug,
  )

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Select target repository for Confluence content
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose the GitHub repository where Confluence content will be synced.
        </p>
      </div>
      <div className="space-y-4">
        <ConnectorContextRepositoryGuidance
          suggestedTarget={suggestedTargetQuery.data}
        />
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

        <p className="text-sm text-muted-foreground">
          Need a repository?{" "}
          <a
            href={createRepositoryUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
          >
            Create {CONNECTOR_CONTEXT_REPOSITORY_NAME} on GitHub
            <IconExternalLink className="size-3.5" aria-hidden />
          </a>
          .
        </p>

        {repoSearchResults?.repositorySelection === "selected" &&
        repoSearchResults.manageUrl ? (
          <p className="text-sm text-muted-foreground">
            Once created,{" "}
            <a
              href={repoSearchResults.manageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
            >
              manage ctx| repository access
              <IconExternalLink className="size-3.5" aria-hidden />
            </a>
            , then return here.
          </p>
        ) : null}

        <Button
          variant="secondary"
          className="rounded-none"
          isDisabled={isSearchingRepos}
          onPress={() => void refetchRepositories()}
        >
          Refresh repositories
        </Button>

        {selectedRepo ? (
          <div className="rounded-none border border-border p-3">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Default branch
            </div>
            <div className="mt-1 text-sm text-foreground">
              {selectedRepo.default_branch}
            </div>
          </div>
        ) : null}

        {isSearchingRepos ? <GithubRepoPickerSkeleton rows={4} /> : null}

        {!isSearchingRepos &&
        debouncedRepoSearch.length > 0 &&
        repoSearchResults?.repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repositories found. Try a different search, or link more repos
            from the repositories page.
          </p>
        ) : null}

        <Button
          variant="primary"
          className="rounded-none"
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
