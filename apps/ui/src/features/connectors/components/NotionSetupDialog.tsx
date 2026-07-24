"use client"

import {
  IconBrandNotion,
  IconExternalLink,
  IconSearch,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import type { Repository } from "@/features/repositories"
import { client } from "@/lib/api"
import {
  atlassianConnectorKeys,
  searchGithubInstallationRepos,
} from "../queries/atlassian-connector"
import {
  fetchNotionConnectorConfig,
  fetchNotionConnectorStatus,
  notionConnectorKeys,
  patchNotionConnectorConfig,
  searchNotionResources,
} from "../queries/notion-connector"
import type { NotionResource } from "../types"
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
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function NotionSetupDialog({
  orgSlug,
  connectionId,
  isOpen,
  onOpenChange,
}: NotionSetupDialogProps) {
  const queryClient = useQueryClient()
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
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

  useEffect(() => {
    const config = configQuery.data
    if (initialized || !config) return
    setSelectedResources(config.resources)
    if (config.syncTarget) {
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
    }
    setInitialized(true)
  }, [configQuery.data, initialized, orgRepos])

  const repoResultsQuery = useQuery({
    queryKey: atlassianConnectorKeys.githubRepos(
      orgSlug,
      debouncedRepoSearch,
      undefined,
    ),
    queryFn: () =>
      searchGithubInstallationRepos(orgSlug, debouncedRepoSearch, undefined),
    enabled: isOpen && Boolean(statusQuery.data?.isGithubLinked),
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

  const status = statusQuery.data
  const config = configQuery.data
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
              Select target repository
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Notion content is committed into this repository after
              notion/config.yaml is merged.
            </p>
          </div>
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
          {repoResultsQuery.isFetching ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Searching repositories...
            </div>
          ) : null}
          <Button
            variant="primary"
            className="rounded-none"
            isPending={saveTargetMutation.isPending}
            isDisabled={!selectedRepo}
            onPress={() => void saveTargetMutation.mutateAsync()}
          >
            Save sync target
          </Button>
        </div>
      )
    }
    if (
      status.selectedResourceCount > 0 &&
      (status.setupPhase === "awaiting_merge" ||
        status.setupPhase === "initial_sync" ||
        status.pendingConfigPrCreating)
    ) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Merge the open pull request for{" "}
            <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
              notion/config.yaml
            </code>{" "}
            to enable syncing from Git.
          </p>
          {status.pendingConfigPullUrl ? (
            <Button
              variant="outline"
              className="rounded-none"
              href={status.pendingConfigPullUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open pull request
              <IconExternalLink className="size-4" aria-hidden />
            </Button>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Creating pull request...
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium text-foreground">
            Select Notion resources
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick the pages and databases ctxpipe should mirror into GitHub.
            Selected pages include their child pages, including pages added
            later. Database selections include their rows.
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
          isPending={saveResourcesMutation.isPending}
          isDisabled={config === null}
          onPress={() => void saveResourcesMutation.mutateAsync()}
        >
          Save scope
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
                Mirror selected Notion docs into a GitHub repo using the same
                config PR flow as Confluence.
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
        {body}
      </div>
    </Modal>
  )
}
