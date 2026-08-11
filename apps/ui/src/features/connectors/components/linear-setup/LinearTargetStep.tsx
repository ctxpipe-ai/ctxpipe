"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/features/repositories"
import { client } from "@/lib/api"
import { searchGithubInstallationRepos } from "../../queries/atlassian-connector"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "../../queries/github-connector"
import {
  fetchLinearConnectorConfig,
  linearConnectorKeys,
  patchLinearConnectorConfig,
} from "../../queries/linear-connector"
import {
  fetchOrgConnections,
  orgConnectionsKeys,
} from "../../queries/org-connections"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  getConnectorContextRepositoryCreateUrl,
} from "../ConnectorContextRepositoryGuidance"

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
  githubConnectionId: string
}

type LinearTargetStepProps = {
  orgSlug: string
  connectionId: string
  onSaved: () => Promise<unknown>
  onBack?: () => void
}

export function LinearTargetStep({
  orgSlug,
  connectionId,
  onSaved,
  onBack,
}: LinearTargetStepProps) {
  const queryClient = useQueryClient()
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => window.clearTimeout(id)
  }, [repoSearch])

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
  const { data: githubConnections = [] } = useQuery({
    queryKey: orgConnectionsKeys.list(orgSlug),
    queryFn: () => fetchOrgConnections(orgSlug),
    select: (connections) =>
      connections.filter((connection) => connection.type === "github"),
  })
  const { data: searchResults, isFetching } = useQuery({
    queryKey: [
      "linear-github-repositories",
      orgSlug,
      debouncedRepoSearch,
      connectionId,
      githubConnections.map((connection) => connection.id),
    ],
    queryFn: async () => {
      const results = await Promise.allSettled(
        githubConnections.map(async (connection) => {
          const result = await searchGithubInstallationRepos(
            orgSlug,
            debouncedRepoSearch,
            connection.id,
          )
          return {
            ...result,
            repositories: result.repositories.map((repository) => ({
              ...repository,
              githubConnectionId: connection.id,
            })),
          }
        }),
      )
      const successful = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      if (successful.length === 0) {
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        throw failure?.reason instanceof Error
          ? failure.reason
          : new Error("Failed to search GitHub repositories")
      }
      return {
        repositories: [
          ...new Map(
            successful
              .flatMap((result) => result.repositories)
              .map((repository) => [repository.full_name, repository]),
          ).values(),
        ],
        manageUrls: [
          ...new Set(
            successful.flatMap((result) =>
              result.repositorySelection === "selected" && result.manageUrl
                ? [result.manageUrl]
                : [],
            ),
          ),
        ],
        warnings: [
          ...new Set(
            successful.flatMap((result) =>
              result.warning ? [result.warning] : [],
            ),
          ),
        ],
        failedConnectionCount: results.length - successful.length,
      }
    },
    enabled: githubConnections.length > 0,
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
        githubConnectionId: config.syncTarget.githubConnectionId ?? "",
      }
    : null
  const effectiveRepo =
    selectedRepo ?? (repoSearch.length === 0 ? configuredRepo : null)
  const preferredGithubConnectionId =
    effectiveRepo?.githubConnectionId ??
    config?.syncTarget?.githubConnectionId ??
    (githubConnections.length === 1 ? githubConnections[0]?.id : undefined)
  const { data: githubInstallation } = useQuery({
    queryKey: githubConnectorKeys.installation(
      orgSlug,
      preferredGithubConnectionId,
    ),
    queryFn: () =>
      fetchGithubInstallationSummary(orgSlug, preferredGithubConnectionId),
    enabled: Boolean(preferredGithubConnectionId),
  })
  const createRepositoryUrl = getConnectorContextRepositoryCreateUrl(
    githubInstallation?.accountSlug,
  )

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
                githubConnectionId: effectiveRepo.githubConnectionId,
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
          mirror. A private repository is recommended for sensitive customer
          request context.
        </p>
      </div>
      <div className="border border-teal-500/40 bg-teal-500/5 p-4">
        <div className="text-xs font-medium tracking-wide text-teal-300 uppercase">
          Shared connector context repository
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          We recommend using one GitHub repository for all ctxpipe connector
          content. Connector files remain separated under paths such as{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">linear/</code>,{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">notion/</code> and{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">confluence/</code>.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          For your first connector, create{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">
            {CONNECTOR_CONTEXT_REPOSITORY_NAME}
          </code>{" "}
          once, then reuse it for future connectors. You can choose another name
          if your team has its own convention.
        </p>
        <a
          href="https://docs.ctxpipe.ai/docs/connections/context-repository"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm text-teal-400 hover:text-teal-300"
        >
          About connector context repositories
          <IconExternalLink className="size-3.5" aria-hidden />
        </a>
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
      {!effectiveRepo ? (
        <div className="border border-border bg-card/30 p-4">
          <h4 className="text-sm font-medium text-foreground">
            Create your shared context repository
          </h4>
          <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                1
              </span>
              <p>
                <a
                  href={createRepositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
                >
                  Create {CONNECTOR_CONTEXT_REPOSITORY_NAME} on GitHub
                  <IconExternalLink className="size-3.5" aria-hidden />
                </a>
                {githubInstallation?.accountSlug ? (
                  <>
                    {" "}
                    under{" "}
                    <code className="bg-muted px-1 py-0.5 text-[11px]">
                      {githubInstallation.accountSlug}
                    </code>
                  </>
                ) : null}
                .
              </p>
            </li>
            {searchResults?.manageUrls.map((manageUrl, index) => (
              <li key={manageUrl} className="flex gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                  {index + 2}
                </span>
                <p>
                  <a
                    href={manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
                  >
                    Give the ctx| GitHub App access
                    <IconExternalLink className="size-3.5" aria-hidden />
                  </a>{" "}
                  to the new repository.
                </p>
              </li>
            ))}
            <li className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                {(searchResults?.manageUrls.length ?? 0) + 2}
              </span>
              <div>
                <p>Return here and refresh the repository list.</p>
                <Button
                  variant="secondary"
                  className="mt-2 h-8 rounded-none px-3"
                  isPending={isFetching}
                  isDisabled={isFetching}
                  onPress={() =>
                    void queryClient.invalidateQueries({
                      queryKey: ["linear-github-repositories", orgSlug],
                    })
                  }
                >
                  Refresh repositories
                </Button>
              </div>
            </li>
          </ol>
        </div>
      ) : null}
      {isFetching ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Searching repositories...
        </div>
      ) : null}
      {searchResults?.failedConnectionCount ? (
        <InlineAlert
          variant="warning"
          title="Some GitHub connections could not be searched"
        >
          Repositories from healthy GitHub connections are still available.
          Refresh this step to retry the remaining connection
          {searchResults.failedConnectionCount === 1 ? "" : "s"}.
        </InlineAlert>
      ) : null}
      {searchResults?.warnings.map((warning) => (
        <InlineAlert
          key={warning}
          variant="warning"
          title="GitHub connection needs attention"
        >
          {warning}
        </InlineAlert>
      ))}
      {!isFetching &&
      debouncedRepoSearch.length > 0 &&
      searchResults?.repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories found. Create one or grant the GitHub App access, then
          refresh.
        </p>
      ) : null}
      <div className="flex items-center justify-between border-t border-border pt-4">
        {onBack ? (
          <Button variant="secondary" className="rounded-none" onPress={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
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
    </div>
  )
}
