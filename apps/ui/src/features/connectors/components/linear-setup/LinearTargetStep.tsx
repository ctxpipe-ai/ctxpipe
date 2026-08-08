"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/features/repositories"
import { client } from "@/lib/api"
import { searchGithubInstallationRepos } from "../../queries/atlassian-connector"
import {
  fetchLinearConnectorConfig,
  linearConnectorKeys,
  patchLinearConnectorConfig,
} from "../../queries/linear-connector"

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

type LinearTargetStepProps = {
  orgSlug: string
  connectionId: string
  onSaved: () => Promise<unknown>
}

export function LinearTargetStep({
  orgSlug,
  connectionId,
  onSaved,
}: LinearTargetStepProps) {
  const queryClient = useQueryClient()
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")

  const { data: orgRepos } = useQuery({
    queryKey: ["repositories", orgSlug],
    queryFn: async () => {
      const response = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!response.ok) throw new Error("Failed to fetch repositories")
      const body = (await response.json()) as { items: Repository[] }
      return body.items
    },
  })
  const { data: config } = useQuery({
    queryKey: linearConnectorKeys.config(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorConfig(orgSlug, connectionId),
  })
  const { data: searchResults, isFetching } = useQuery({
    queryKey: ["linear-github-repositories", orgSlug, repoSearch, connectionId],
    queryFn: () => searchGithubInstallationRepos(orgSlug, repoSearch),
  })

  const configuredRepo = config?.syncTarget
    ? {
        id: 0,
        full_name: config.syncTarget.repositoryName,
        html_url: `https://github.com/${config.syncTarget.repositoryName}`,
        clone_url:
          orgRepos?.find(
            (repository) => repository.id === config.syncTarget?.repositoryId,
          )?.gitUrl ??
          `https://github.com/${config.syncTarget.repositoryName}.git`,
        name:
          config.syncTarget.repositoryName.split("/").pop() ??
          config.syncTarget.repositoryName,
        default_branch: config.syncTarget.branch,
      }
    : null
  const effectiveRepo =
    selectedRepo ?? (repoSearch.length === 0 ? configuredRepo : null)

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveRepo) throw new Error("Select a repository")
      const contextRepository = orgRepos?.find(
        (repository) =>
          repository.gitUrl === effectiveRepo.clone_url ||
          repository.gitUrl.replace(/\.git$/, "") ===
            effectiveRepo.clone_url.replace(/\.git$/, ""),
      )
      return patchLinearConnectorConfig(orgSlug, connectionId, {
        syncTarget: {
          ...(contextRepository
            ? { repositoryId: contextRepository.id }
            : {
                repositoryName: effectiveRepo.full_name,
                gitUrl: effectiveRepo.clone_url,
              }),
          branch: effectiveRepo.default_branch,
          enabled: true,
        },
      })
    },
    onSuccess: async () => {
      toast.success("Linear sync repository saved.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.config(orgSlug, connectionId),
        }),
        onSaved(),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Select target repository
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose the GitHub repository where ctxpipe will maintain the Linear
          mirror.
        </p>
      </div>
      <ComboBox
        label="Repository"
        placeholder="Search repositories..."
        inputValue={effectiveRepo?.full_name ?? repoSearch}
        onInputChange={(value) => {
          setRepoSearch(value)
          if (effectiveRepo && value !== effectiveRepo.full_name) {
            setSelectedRepo(null)
          }
        }}
        onSelectionChange={(key) => {
          const repository = searchResults?.repositories.find(
            (candidate) => candidate.id.toString() === key,
          )
          if (repository) {
            setSelectedRepo(repository)
            setRepoSearch(repository.full_name)
          }
        }}
        items={searchResults?.repositories ?? []}
      >
        {(repository) => (
          <ComboBoxItem
            id={repository.id.toString()}
            textValue={repository.full_name}
          >
            {repository.full_name}
          </ComboBoxItem>
        )}
      </ComboBox>
      {isFetching ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Searching repositories...
        </div>
      ) : null}
      <Button
        variant="primary"
        className="rounded-none"
        isPending={saveMutation.isPending}
        isDisabled={!effectiveRepo}
        onPress={() => saveMutation.mutate()}
      >
        Save repository
      </Button>
    </div>
  )
}
