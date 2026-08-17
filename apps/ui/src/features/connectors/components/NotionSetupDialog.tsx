"use client"

import {
  IconBrandNotion,
  IconExternalLink,
  IconSearch,
} from "@tabler/icons-react"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/features/repositories"
import { client } from "@/lib/api"
import {
  getNotionFailureAction,
  getNotionSetupCurrentIndex,
  hasNotionScopeChanged,
  NOTION_SETUP_STEPS,
  shouldShowNotionSetupComplete,
} from "../notion-setup-model"
import {
  atlassianConnectorKeys,
  searchGithubInstallationRepos,
} from "../queries/atlassian-connector"
import {
  connectorSyncTargetKeys,
  fetchSuggestedConnectorSyncTarget,
} from "../queries/connector-sync-target"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "../queries/github-connector"
import {
  fetchNotionConnectorConfig,
  fetchNotionConnectorStatus,
  notionConnectorKeys,
  patchNotionConnectorConfig,
  retryNotionConfig,
  retryNotionSync,
  searchNotionResources,
} from "../queries/notion-connector"
import type { NotionResource } from "../types"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  ConnectorContextRepositoryGuidance,
  getConnectorContextRepositoryCreateUrl,
} from "./ConnectorContextRepositoryGuidance"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

type NotionSetupDialogProps = {
  orgSlug: string
  connectionId?: string
  githubConnectionIds?: string[]
  manageScope?: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function NotionSetupDialog({
  orgSlug,
  connectionId,
  githubConnectionIds = [],
  manageScope = false,
  isOpen,
  onOpenChange,
}: NotionSetupDialogProps) {
  const queryClient = useQueryClient()
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [selectedGithubConnectionId, setSelectedGithubConnectionId] = useState<
    string | null
  >(null)
  const [resourceSearch, setResourceSearch] = useState("")
  const [debouncedResourceSearch, setDebouncedResourceSearch] = useState("")
  const [selectedResources, setSelectedResources] = useState<NotionResource[]>(
    [],
  )
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => clearTimeout(id)
  }, [repoSearch])

  useEffect(() => {
    const id = setTimeout(() => setDebouncedResourceSearch(resourceSearch), 300)
    return () => clearTimeout(id)
  }, [resourceSearch])

  const statusQuery = useQuery({
    queryKey: notionConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchNotionConnectorStatus(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!isOpen) return false
      if (
        data?.setupPhase === "awaiting_merge" ||
        data?.setupPhase === "initial_sync" ||
        data?.pendingConfigPrCreating
      ) {
        return 2000
      }
      return false
    },
  })

  const configQuery = useQuery({
    queryKey: notionConnectorKeys.config(orgSlug, connectionId),
    queryFn: () => fetchNotionConnectorConfig(orgSlug, connectionId),
    enabled: isOpen && Boolean(connectionId),
  })

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
    enabled: isOpen,
  })

  const suggestedTargetQuery = useQuery({
    queryKey: connectorSyncTargetKeys.suggestion(orgSlug),
    queryFn: () => fetchSuggestedConnectorSyncTarget(orgSlug),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isGithubLinked) &&
      !statusQuery.data?.syncTargetConfigured,
  })

  const activeGithubConnectionId =
    selectedGithubConnectionId ??
    configQuery.data?.syncTarget?.githubConnectionId ??
    suggestedTargetQuery.data?.githubConnectionId ??
    (githubConnectionIds.length === 1 ? githubConnectionIds[0] : undefined)

  const githubInstallationQueries = useQueries({
    queries: githubConnectionIds.map((githubConnectionId) => ({
      queryKey: githubConnectorKeys.installation(orgSlug, githubConnectionId),
      queryFn: () =>
        fetchGithubInstallationSummary(orgSlug, githubConnectionId),
      enabled:
        isOpen &&
        Boolean(statusQuery.data?.isGithubLinked) &&
        !statusQuery.data?.syncTargetConfigured,
    })),
  })
  const githubConnectionOptions = githubConnectionIds.map(
    (githubConnectionId, index) => {
      const installation = githubInstallationQueries[index]?.data
      return {
        id: githubConnectionId,
        label:
          installation?.accountSlug && installation.appSlug
            ? `${installation.accountSlug} — ${installation.appSlug}`
            : (installation?.accountSlug ??
              installation?.appSlug ??
              githubConnectionId),
      }
    },
  )
  const githubInstallation = githubInstallationQueries.find(
    (query) => query.data?.id === activeGithubConnectionId,
  )?.data

  useEffect(() => {
    const config = configQuery.data
    if (initialized || config === undefined || suggestedTargetQuery.isPending)
      return
    setSelectedResources(config?.resources ?? [])
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
    setInitialized(true)
  }, [
    configQuery.data,
    initialized,
    orgRepos,
    suggestedTargetQuery.data,
    suggestedTargetQuery.isPending,
  ])

  const repoResultsQuery = useQuery({
    queryKey: atlassianConnectorKeys.githubRepos(
      orgSlug,
      debouncedRepoSearch,
      activeGithubConnectionId,
    ),
    queryFn: () =>
      searchGithubInstallationRepos(
        orgSlug,
        debouncedRepoSearch,
        activeGithubConnectionId,
      ),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isGithubLinked) &&
      Boolean(activeGithubConnectionId),
    refetchOnWindowFocus: "always",
  })

  const resourcesQuery = useQuery({
    queryKey: notionConnectorKeys.resources(
      orgSlug,
      connectionId,
      debouncedResourceSearch,
    ),
    queryFn: () =>
      searchNotionResources(orgSlug, debouncedResourceSearch, connectionId),
    enabled:
      isOpen && Boolean(connectionId) && Boolean(statusQuery.data?.isInstalled),
  })

  const selectedIds = useMemo(
    () => new Set(selectedResources.map((resource) => resource.externalId)),
    [selectedResources],
  )
  const createRepositoryUrl = getConnectorContextRepositoryCreateUrl(
    githubInstallation?.accountSlug,
  )

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
      return patchNotionConnectorConfig(
        orgSlug,
        {
          syncTarget: {
            ...(ctxRepo ? { repositoryId: ctxRepo.id } : {}),
            repositoryName: selectedRepo.full_name,
            gitUrl: selectedRepo.clone_url,
            githubConnectionId: activeGithubConnectionId,
            branch: selectedRepo.default_branch,
            enabled: true,
          },
        },
        connectionId,
      )
    },
    onSuccess: async () => {
      toast.success("Notion sync target saved.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const saveResourcesMutation = useMutation({
    mutationFn: () =>
      patchNotionConnectorConfig(
        orgSlug,
        { resources: selectedResources },
        connectionId,
      ),
    onSuccess: async ({ savedCount, configPrEnqueued }) => {
      toast.success(
        configPrEnqueued
          ? `Scope saved (${savedCount} resources). A pull request for notion/config.yaml is being created.`
          : `Scope saved (${savedCount} resources).`,
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const retrySyncMutation = useMutation({
    mutationFn: () => {
      if (!connectionId) throw new Error("Missing Notion connection")
      return retryNotionSync(orgSlug, connectionId)
    },
    onSuccess: async () => {
      toast.success("Notion content sync retry started.")
      await queryClient.invalidateQueries({
        queryKey: notionConnectorKeys.status(orgSlug, connectionId),
      })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const retryConfigMutation = useMutation({
    mutationFn: () => {
      if (!connectionId) throw new Error("Missing Notion connection")
      return retryNotionConfig(
        orgSlug,
        connectionId,
        selectedResources.length > 0 ? selectedResources : undefined,
      )
    },
    onSuccess: async () => {
      toast.success("Configuration pull request retry started.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: notionConnectorKeys.config(orgSlug, connectionId),
        }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const status = statusQuery.data
  const config = configQuery.data
  const failureAction = status ? getNotionFailureAction(status) : null
  const scopeChanged = hasNotionScopeChanged(
    config?.resources ?? [],
    selectedResources,
  )
  const editingLiveScope = status?.setupPhase === "live" && manageScope
  const setupStepIndex = status ? getNotionSetupCurrentIndex(status) : 0
  const body = (() => {
    if (!connectionId) {
      return (
        <p className="text-sm text-muted-foreground">
          Connect Notion from the Add connection menu first.
        </p>
      )
    }
    if (statusQuery.isPending || configQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading Notion connector...
        </div>
      )
    }
    if (!status?.isInstalled) {
      return (
        <p className="text-sm text-muted-foreground">
          This Notion connection is not installed. Reconnect Notion from the Add
          connection menu.
        </p>
      )
    }
    if (!status.isGithubLinked) {
      return (
        <GitHubPrerequisiteStep
          orgSlug={orgSlug}
          sourceName="Notion"
          onConnected={async () => {
            await queryClient.invalidateQueries({
              queryKey: notionConnectorKeys.status(orgSlug, connectionId),
            })
          }}
        />
      )
    }
    if (!status.syncTargetConfigured) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Select a repository for Notion content
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose where ctxpipe should mirror your selected Notion pages and
              databases.
            </p>
          </div>
          <ConnectorContextRepositoryGuidance
            suggestedTarget={suggestedTargetQuery.data}
          />
          {githubConnectionOptions.length > 1 ? (
            <ComboBox
              label="GitHub connection"
              placeholder="Select a GitHub account..."
              description="Choose the GitHub App installation that can access the context repository."
              selectedKey={activeGithubConnectionId ?? null}
              onSelectionChange={(key) => {
                setSelectedGithubConnectionId(key ? String(key) : null)
                setSelectedRepo(null)
                setRepoSearch("")
              }}
              items={githubConnectionOptions}
            >
              {(option) => (
                <ComboBoxItem id={option.id} textValue={option.label}>
                  {option.label}
                </ComboBoxItem>
              )}
            </ComboBox>
          ) : null}
          <ComboBox
            label="Repository"
            placeholder="Type to search repositories..."
            isDisabled={!activeGithubConnectionId}
            inputValue={selectedRepo?.full_name ?? repoSearch}
            onInputChange={(value) => {
              setRepoSearch(value)
              if (selectedRepo && value !== selectedRepo.full_name) {
                setSelectedRepo(null)
              }
            }}
            onSelectionChange={(key) => {
              const repo = repoResultsQuery.data?.repositories.find(
                (r) => r.id.toString() === key,
              )
              if (repo) {
                setSelectedRepo(repo)
                setRepoSearch(repo.full_name)
              }
            }}
            items={repoResultsQuery.data?.repositories ?? []}
          >
            {(repo) => (
              <ComboBoxItem id={repo.id.toString()} textValue={repo.full_name}>
                {repo.full_name}
              </ComboBoxItem>
            )}
          </ComboBox>

          {!selectedRepo ? (
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
                    .
                  </p>
                </li>
                {repoResultsQuery.data?.repositorySelection === "selected" &&
                repoResultsQuery.data.manageUrl ? (
                  <li className="flex gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                      2
                    </span>
                    <p>
                      <a
                        href={repoResultsQuery.data.manageUrl}
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
                ) : null}
                <li className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                    {repoResultsQuery.data?.repositorySelection ===
                      "selected" && repoResultsQuery.data.manageUrl
                      ? 3
                      : 2}
                  </span>
                  <div>
                    <p>Return here and refresh the repository list.</p>
                    <Button
                      variant="secondary"
                      className="mt-2 h-8 rounded-none px-3"
                      isPending={repoResultsQuery.isFetching}
                      onPress={() => void repoResultsQuery.refetch()}
                    >
                      Refresh repositories
                    </Button>
                  </div>
                </li>
              </ol>
            </div>
          ) : null}

          {repoResultsQuery.isFetching ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Searching repositories...
            </div>
          ) : null}

          <div className="flex justify-end border-t border-border pt-4">
            <Button
              variant="primary"
              className="rounded-none"
              isPending={saveTargetMutation.isPending}
              isDisabled={!selectedRepo || !activeGithubConnectionId}
              onPress={() => void saveTargetMutation.mutateAsync()}
            >
              Continue
            </Button>
          </div>
        </div>
      )
    }
    if (failureAction === "retry_content") {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Notion content sync failed
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Your approved configuration remains intact. Retry the content
              mirror without creating another pull request.
            </p>
          </div>
          <Button
            variant="primary"
            className="rounded-none"
            isPending={retrySyncMutation.isPending}
            onPress={() => retrySyncMutation.mutate()}
          >
            Retry content sync
          </Button>
        </div>
      )
    }
    if (
      failureAction === "retry_config" &&
      (selectedResources.length > 0 || status.pendingConfigPullUrl)
    ) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Configuration pull request failed
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Retry creating the reviewable configuration pull request. Notion
              content is not synchronised until the pull request is merged.
            </p>
          </div>
          <Button
            variant="primary"
            className="rounded-none"
            isPending={retryConfigMutation.isPending}
            onPress={() => retryConfigMutation.mutate()}
          >
            Retry configuration pull request
          </Button>
        </div>
      )
    }
    if (
      status.pendingConfigPrCreating ||
      status.pendingConfigPullUrl ||
      status.setupPhase === "awaiting_merge" ||
      status.setupPhase === "initial_sync"
    ) {
      const creatingPullRequest = status.pendingConfigPrCreating
      const syncingAfterMerge = status.setupPhase === "initial_sync"
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {syncingAfterMerge ? (
              <>
                Your configuration is merged. We are syncing Notion content to
                Git from{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  notion/config.yaml
                </code>
                .
              </>
            ) : (
              <>
                ctxpipe first proposes only the approved sync scope in{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  notion/config.yaml
                </code>
                . Review and merge the pull request before any Notion content is
                mirrored.
              </>
            )}
          </p>
          {syncingAfterMerge ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Syncing Notion content to Git…
            </div>
          ) : status.pendingConfigPullUrl ? (
            <Button
              variant="outline"
              className="rounded-none"
              onPress={() =>
                window.open(
                  status.pendingConfigPullUrl ?? "",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Open pull request
              <IconExternalLink className="size-4" aria-hidden />
            </Button>
          ) : creatingPullRequest ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Spinner className="size-4" />
                Creating pull request…
              </div>
              <p>
                This usually takes 30–90 seconds while ctxpipe starts the sync
                worker and prepares the repository. You can close this dialog;
                setup will continue in the background.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pull request creation failed. Try again; if it continues to
                fail, check that the GitHub App can write to the repository.
              </p>
              <Button
                variant="outline"
                className="rounded-none"
                isPending={saveResourcesMutation.isPending}
                onPress={() => saveResourcesMutation.mutate()}
              >
                Try creating pull request again
              </Button>
            </div>
          )}
        </div>
      )
    }
    if (shouldShowNotionSetupComplete(status, manageScope)) {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium text-foreground">
              Notion is connected
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              The approved scope is stored in{" "}
              <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                notion/config.yaml
              </code>
              , and the selected Notion content is now mirrored to Git. You can
              manage scope later from the connector card.
            </p>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      )
    }

    return (
      <div className="space-y-4">
        {failureAction === "retry_config" ? (
          <div className="border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-foreground">
              Configuration pull request failed
            </p>
            <p className="mt-1 text-muted-foreground">
              Select the Notion resources again, then retry creating the pull
              request.
            </p>
          </div>
        ) : null}
        <div>
          <h3 className="text-base font-medium text-foreground">
            {editingLiveScope
              ? "Manage Notion scope"
              : "Select Notion resources"}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {editingLiveScope ? (
              <>
                Scope changes are proposed through{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  notion/config.yaml
                </code>
                . Sync updates after you review and merge the pull request.
              </>
            ) : (
              <>
                Pick the pages and databases ctxpipe should mirror into GitHub.
                Your selection is proposed in{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  notion/config.yaml
                </code>{" "}
                and content sync begins after you merge the pull request.
                Selected pages include their child pages, including pages added
                later. Database selections include their rows.
              </>
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-none border border-border bg-card/40 px-3 py-2 text-sm">
          <IconSearch className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={resourceSearch}
            onChange={(event) => setResourceSearch(event.target.value)}
            placeholder="Search Notion pages and databases"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Button
          variant="secondary"
          className="rounded-none"
          isPending={resourcesQuery.isFetching}
          onPress={() => void resourcesQuery.refetch()}
        >
          Refresh Notion resources
        </Button>
        <div className="max-h-72 overflow-auto border border-border">
          {resourcesQuery.isFetching ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Searching Notion...
            </div>
          ) : resourcesQuery.isError ? (
            <p className="p-3 text-sm text-destructive">
              Failed to load Notion resources. Try again.
            </p>
          ) : (resourcesQuery.data ?? []).length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No Notion resources found.
            </p>
          ) : (
            (resourcesQuery.data ?? []).map((resource) => (
              <label
                key={resource.externalId}
                className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(resource.externalId)}
                  onChange={(event) => {
                    if (event.currentTarget.checked) {
                      setSelectedResources((prev) =>
                        prev.some((r) => r.externalId === resource.externalId)
                          ? prev
                          : [...prev, resource],
                      )
                    } else {
                      setSelectedResources((prev) =>
                        prev.filter(
                          (r) => r.externalId !== resource.externalId,
                        ),
                      )
                    }
                  }}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {resource.title}
                  </span>
                  <span className="block text-xs uppercase text-muted-foreground">
                    {resource.type}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        {selectedResources.length > 0 ? (
          <div className="text-sm text-muted-foreground">
            {selectedResources.length} selected
          </div>
        ) : null}
        <Button
          variant="primary"
          className="rounded-none"
          isPending={
            failureAction === "retry_config"
              ? retryConfigMutation.isPending
              : saveResourcesMutation.isPending
          }
          isDisabled={
            failureAction === "retry_config"
              ? selectedResources.length === 0
              : config === null ||
                !scopeChanged ||
                (!editingLiveScope && selectedResources.length === 0)
          }
          onPress={() =>
            void (failureAction === "retry_config"
              ? retryConfigMutation.mutateAsync()
              : saveResourcesMutation.mutateAsync())
          }
        >
          {failureAction === "retry_config"
            ? "Retry configuration pull request"
            : editingLiveScope
              ? "Propose scope changes"
              : "Create configuration pull request"}
        </Button>
      </div>
    )
  })()

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandNotion className="size-5 text-foreground" aria-hidden />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Notion connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Mirror selected Notion content into a GitHub repository through
                a reviewable configuration pull request.
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
        {status?.isInstalled ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={NOTION_SETUP_STEPS}
              currentIndex={setupStepIndex}
            />
          </div>
        ) : null}
        {body}
      </div>
    </Modal>
  )
}
