"use client"

import {
  IconBrandSlack,
  IconCircleCheckFilled,
  IconExternalLink,
} from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { ComboBox, ComboBoxItem } from "@/components/ui/ComboBox"
import { Modal } from "@/components/ui/Modal"
import { NumberField } from "@/components/ui/NumberField"
import { Spinner } from "@/components/ui/spinner"
import { client } from "@/lib/api"
import { searchGithubInstallationRepos } from "../queries/atlassian-connector"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "../queries/github-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchSlackAvailableChannels,
  fetchSlackConnectorStatus,
  fetchSlackOAuthStart,
  patchSlackConnectorConfig,
  type SlackAvailableChannel,
  SlackOAuthNotConfiguredError,
  slackConnectorKeys,
} from "../queries/slack-connector"
import {
  getSlackDraftStep,
  getSlackSetupStepIndex,
  getSlackSetupView,
  type SlackDraftStep,
} from "../slack-setup-model"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  ConnectorContextRepositoryGuidance,
  getConnectorContextRepositoryCreateUrl,
} from "./ConnectorContextRepositoryGuidance"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

export const SLACK_SETUP_RESULT_KEY = "slack-setup-result"

const SLACK_DOCS_URL =
  "https://docs.ctxpipe.ai/docs/connections/source-connectors/slack"

const SLACK_SETUP_STEPS = [
  { id: "authorize", label: "Authorize Slack workspace" },
  { id: "github", label: "Connect GitHub" },
  { id: "channels", label: "Select channels" },
  { id: "target", label: "Choose context repository" },
  { id: "merge", label: "Approve configuration in GitHub" },
] as const

type SlackSetupDialogProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  connectionId?: string
}

type RepoRow = {
  id: string
  name: string
  gitUrl: string
  githubConnectionId: string | null
}

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

export function SlackSetupDialog({
  orgSlug,
  isOpen,
  onOpenChange,
  connectionId: initialConnectionId,
}: SlackSetupDialogProps) {
  const queryClient = useQueryClient()
  const [connectionId, setConnectionId] = useState<string | undefined>(
    initialConnectionId,
  )
  const [selected, setSelected] = useState<Map<string, SlackAvailableChannel>>(
    new Map(),
  )
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [oldestDays, setOldestDays] = useState(90)
  const [showCompletion, setShowCompletion] = useState(false)
  const [manualDraftStep, setManualDraftStep] = useState<SlackDraftStep | null>(
    null,
  )

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => window.clearTimeout(id)
  }, [repoSearch])

  const statusQuery = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    enabled: isOpen,
    refetchInterval: (query) => {
      const status = query.state.data
      if (!isOpen) return false
      if (
        status?.pendingConfigPrCreating ||
        status?.setupPhase === "awaiting_merge" ||
        status?.setupPhase === "initial_sync"
      ) {
        return 2000
      }
      return false
    },
  })

  const channelsQuery = useQuery({
    queryKey: slackConnectorKeys.channels(orgSlug, connectionId),
    queryFn: () => fetchSlackAvailableChannels(orgSlug, connectionId),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isInstalled) &&
      Boolean(statusQuery.data?.isGithubLinked),
  })

  const reposQuery = useQuery({
    queryKey: ["slack-setup-repos", orgSlug],
    queryFn: async (): Promise<RepoRow[]> => {
      const res = await client[":orgSlug"].api.v1.repositories.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to list repositories")
      const json = (await res.json()) as {
        items?: RepoRow[]
        repositories?: RepoRow[]
      }
      return json.items ?? json.repositories ?? []
    },
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isInstalled) &&
      Boolean(statusQuery.data?.isGithubLinked),
  })

  const repoResultsQuery = useQuery({
    queryKey: [
      "slack-setup-github-repos",
      orgSlug,
      debouncedRepoSearch,
      statusQuery.data?.syncTarget?.githubConnectionId,
    ],
    queryFn: () =>
      searchGithubInstallationRepos(
        orgSlug,
        debouncedRepoSearch,
        statusQuery.data?.syncTarget?.githubConnectionId ?? undefined,
      ),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isInstalled) &&
      Boolean(statusQuery.data?.isGithubLinked),
  })
  const githubInstallationQuery = useQuery({
    queryKey: githubConnectorKeys.installation(
      orgSlug,
      statusQuery.data?.syncTarget?.githubConnectionId ?? undefined,
    ),
    queryFn: () =>
      fetchGithubInstallationSummary(
        orgSlug,
        statusQuery.data?.syncTarget?.githubConnectionId ?? undefined,
      ),
    enabled: isOpen && Boolean(statusQuery.data?.isGithubLinked),
  })
  const createRepositoryUrl = getConnectorContextRepositoryCreateUrl(
    githubInstallationQuery.data?.accountSlug,
  )

  useEffect(() => {
    const st = statusQuery.data
    if (!st) return
    if (st.syncTarget?.repositoryId) {
      const name = st.syncTarget.repositoryName
      const fromOrg = reposQuery.data?.find(
        (repo) => repo.id === st.syncTarget?.repositoryId,
      )
      setSelectedRepo({
        id: 0,
        full_name: name,
        html_url:
          fromOrg?.gitUrl.replace(/\.git$/, "") ?? `https://github.com/${name}`,
        clone_url: fromOrg?.gitUrl ?? `https://github.com/${name}.git`,
        name: fromOrg?.name ?? name.split("/").pop() ?? name,
        default_branch: st.syncTarget.branch,
      })
      setRepoSearch(name)
    }
    if (st.oldestDays) setOldestDays(st.oldestDays)
    if (st.selectedChannels.length > 0) {
      setSelected(
        new Map(
          st.selectedChannels.map((ch) => [
            ch.channelId,
            {
              id: ch.channelId,
              name: ch.name,
              isPrivate: ch.isPrivate,
              isMember: true,
            },
          ]),
        ),
      )
    }
  }, [reposQuery.data, statusQuery.data])

  const consumeSetupResult = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(SLACK_SETUP_RESULT_KEY)
      if (!raw) return
      window.localStorage.removeItem(SLACK_SETUP_RESULT_KEY)
      const parsed = JSON.parse(raw) as {
        connectionId?: string
        error?: string
      }
      if (parsed.error) {
        toast.error(parsed.error)
        return
      }
      if (parsed.connectionId) {
        setConnectionId(parsed.connectionId)
        void queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        })
        void queryClient.invalidateQueries({
          queryKey: slackConnectorKeys.status(orgSlug, parsed.connectionId),
        })
      }
    } catch {
      // ignore
    }
  }, [orgSlug, queryClient])

  useEffect(() => {
    if (!isOpen) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === SLACK_SETUP_RESULT_KEY) consumeSetupResult()
    }
    window.addEventListener("storage", onStorage)
    const id = window.setInterval(consumeSetupResult, 800)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.clearInterval(id)
    }
  }, [isOpen, consumeSetupResult])

  const oauthMutation = useMutation({
    mutationFn: () => fetchSlackOAuthStart(orgSlug),
    onSuccess: ({ authorizationUrl }) => {
      window.open(authorizationUrl, "slack-oauth", "popup,width=720,height=800")
    },
    onError: (err) => {
      if (err instanceof SlackOAuthNotConfiguredError) {
        toast.error(
          "Slack is not configured on this deployment. Ask an operator to set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET.",
        )
        return
      }
      toast.error(err instanceof Error ? err.message : "OAuth failed")
    },
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRepo) throw new Error("Select a sync target repository")
      if (selected.size === 0) throw new Error("Select at least one channel")
      const repository = reposQuery.data?.find(
        (repo) =>
          repo.gitUrl === selectedRepo.clone_url ||
          repo.name === selectedRepo.name ||
          repo.gitUrl.replace(/\.git$/, "") ===
            selectedRepo.clone_url.replace(/\.git$/, ""),
      )
      return patchSlackConnectorConfig(
        orgSlug,
        {
          channels: [...selected.values()].map((ch) => ({
            channelId: ch.id,
            name: ch.name,
            isPrivate: ch.isPrivate,
          })),
          syncTarget: {
            ...(repository
              ? { repositoryId: repository.id }
              : {
                  repositoryName: selectedRepo.full_name,
                  gitUrl: selectedRepo.clone_url,
                  githubConnectionId:
                    statusQuery.data?.syncTarget?.githubConnectionId ??
                    undefined,
                }),
            branch: selectedRepo.default_branch,
            enabled: true,
            oldestDays,
          },
        },
        connectionId,
      )
    },
    onSuccess: async (result) => {
      toast.success(
        result.configPrEnqueued
          ? "Configuration saved. Creating a pull request for slack/config.yaml…"
          : "Slack connector settings saved",
      )
      setShowCompletion(result.configPrEnqueued)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: slackConnectorKeys.status(orgSlug, connectionId),
        }),
      ])
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Save failed")
    },
  })

  const status = statusQuery.data
  const statusWithLocalChannels = status
    ? {
        ...status,
        selectedChannelCount: Math.max(
          selected.size,
          status.selectedChannelCount,
        ),
      }
    : undefined
  const setupStepIndex = getSlackSetupStepIndex(statusWithLocalChannels)
  const setupView = getSlackSetupView({
    status,
    isPending: statusQuery.isPending,
    isError: statusQuery.isError,
    showCompletion,
  })
  const draftStep =
    manualDraftStep ?? (status ? getSlackDraftStep(status) : "channels")
  const draftStepIndex = draftStep === "channels" ? 2 : 3
  const setupFocusOverride =
    setupView === "configure" && draftStepIndex < setupStepIndex
      ? draftStepIndex
      : null

  const channels = channelsQuery.data ?? []
  const setOpen = (open: boolean) => {
    if (!open) {
      setShowCompletion(false)
      setManualDraftStep(null)
    }
    onOpenChange(open)
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={setOpen}
      isDismissable
      className="max-w-[min(92vw,720px)]"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="ctx-node h-9 w-9">
              <IconBrandSlack className="size-5 text-foreground" aria-hidden />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Slack connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Mirror selected Slack channels into a GitHub repository through
                a reviewable configuration pull request.
              </p>
              <a
                href={SLACK_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sm text-teal-400 hover:text-teal-300"
              >
                Slack connector docs
                <IconExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
          </div>
          <Button
            variant="secondary"
            className="rounded-none"
            onPress={() => setOpen(false)}
          >
            Close
          </Button>
        </div>

        {status && !statusQuery.isPending && !statusQuery.isError ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={SLACK_SETUP_STEPS}
              currentIndex={setupStepIndex}
              focusOverride={setupFocusOverride}
            />
          </div>
        ) : null}

        {setupView === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading Slack connector…
          </div>
        ) : setupView === "error" ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                Slack connector unavailable
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                ctxpipe could not load this connection. Retry before changing
                its configuration.
              </p>
            </div>
            <Button
              variant="secondary"
              className="rounded-none"
              isPending={statusQuery.isFetching}
              onPress={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : setupView === "authorize" ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                Authorize Slack workspace
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Install the ctxpipe Slack app into your workspace to continue.
              </p>
            </div>
            <Button
              className="rounded-none"
              onPress={() => oauthMutation.mutate()}
              isPending={oauthMutation.isPending}
            >
              Connect Slack
            </Button>
          </div>
        ) : setupView === "github" ? (
          <GitHubPrerequisiteStep
            orgSlug={orgSlug}
            sourceName="Slack"
            onConnected={async () => {
              await queryClient.invalidateQueries({
                queryKey: slackConnectorKeys.status(orgSlug, connectionId),
              })
            }}
          />
        ) : setupView === "creating_pr" ||
          setupView === "awaiting_merge" ||
          setupView === "initial_sync" ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                {setupView === "initial_sync"
                  ? "Syncing Slack content"
                  : "Approve configuration in GitHub"}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {setupView === "initial_sync" ? (
                  <>
                    Your configuration is merged. ctxpipe is mirroring the
                    selected Slack channels to Git from{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      slack/config.yaml
                    </code>
                    .
                  </>
                ) : (
                  <>
                    ctxpipe proposes the selected channels and history window in{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      slack/config.yaml
                    </code>
                    . Review and merge the pull request before Slack content is
                    mirrored.
                  </>
                )}
              </p>
            </div>
            {setupView === "creating_pr" || setupView === "initial_sync" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                {setupView === "creating_pr"
                  ? "Creating pull request…"
                  : "Syncing Slack content to Git…"}
              </div>
            ) : null}
            {setupView === "awaiting_merge" && status?.pendingConfigPullUrl ? (
              <Button
                className="rounded-none"
                href={status.pendingConfigPullUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <IconExternalLink className="mr-2 size-4" aria-hidden />
                Open pull request
              </Button>
            ) : null}
            {setupView === "awaiting_merge" && !status?.pendingConfigPullUrl ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Pull request creation failed. Try again; if it continues to
                  fail, check that the GitHub App can write to the repository.
                </p>
                <Button
                  variant="secondary"
                  className="rounded-none"
                  isPending={saveMutation.isPending}
                  onPress={() => saveMutation.mutate()}
                >
                  Try creating pull request again
                </Button>
              </div>
            ) : null}
          </div>
        ) : setupView === "complete" ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <IconCircleCheckFilled
                className="mt-0.5 size-5 shrink-0 text-emerald-500"
                aria-hidden
              />
              <div>
                <h3 className="text-base font-medium text-foreground">
                  Slack connector is live
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Selected channels are mirrored into{" "}
                  <span className="text-foreground">
                    {status?.syncTarget?.repositoryName}
                  </span>
                  . New Slack activity is coalesced and written to Git within
                  the connector&apos;s freshness window.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="secondary"
                className="rounded-none"
                onPress={() => {
                  setShowCompletion(false)
                  setManualDraftStep("channels")
                }}
              >
                Manage channels
              </Button>
              <Button className="rounded-none" onPress={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : draftStep === "channels" ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                Select channels
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Public channels in {status?.teamName ?? "Slack"} are listed
                below. Run{" "}
                <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                  /invite
                </code>{" "}
                and choose the installed ctxpipe app before selecting a channel.
                Private channels appear only after the app is invited.
              </p>
            </div>
            <Button
              variant="secondary"
              className="rounded-none"
              isPending={channelsQuery.isFetching}
              onPress={() => void channelsQuery.refetch()}
            >
              Refresh channels
            </Button>
            <div className="max-h-72 overflow-auto border border-border">
              {channelsQuery.isFetching && channels.length === 0 ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Loading channels…
                </div>
              ) : channelsQuery.isError ? (
                <p className="p-3 text-sm text-destructive">
                  {channelsQuery.error instanceof Error
                    ? channelsQuery.error.message
                    : "Failed to load Slack channels. Try again."}
                </p>
              ) : channels.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No public channels found. Invite the app to a private channel,
                  then refresh.
                </p>
              ) : (
                channels.map((ch) => (
                  <label
                    key={ch.id}
                    className={`flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 ${
                      ch.isMember
                        ? "cursor-pointer hover:bg-foreground/[0.03]"
                        : "cursor-not-allowed opacity-70"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(ch.id)}
                      disabled={!ch.isMember}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked
                        setSelected((prev) => {
                          const next = new Map(prev)
                          if (checked) next.set(ch.id, ch)
                          else next.delete(ch.id)
                          return next
                        })
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-foreground">
                        #{ch.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {ch.isPrivate ? "Private" : "Public"}
                        {!ch.isMember ? " · Invite app to select" : ""}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">
                {selected.size} selected
              </span>
              <Button
                className="rounded-none"
                isDisabled={selected.size === 0}
                onPress={() => setManualDraftStep("target")}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                Select a repository for Slack content
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose where ctxpipe should mirror your selected Slack channels.
                Use a private repository when mirroring private channels.
              </p>
            </div>
            <ConnectorContextRepositoryGuidance />
            <ComboBox
              label="Repository"
              placeholder="Type to search repositories..."
              selectedKey={selectedRepo?.id.toString() ?? null}
              inputValue={selectedRepo?.full_name ?? repoSearch}
              onInputChange={(value) => {
                setRepoSearch(value)
                if (selectedRepo && value !== selectedRepo.full_name) {
                  setSelectedRepo(null)
                }
              }}
              onSelectionChange={(key) => {
                const repo = repoResultsQuery.data?.repositories.find(
                  (item) => item.id.toString() === String(key),
                )
                if (repo) {
                  setSelectedRepo(repo)
                  setRepoSearch(repo.full_name)
                }
              }}
              items={repoResultsQuery.data?.repositories ?? []}
            >
              {(repo) => (
                <ComboBoxItem
                  id={repo.id.toString()}
                  textValue={repo.full_name}
                >
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
                Searching repositories…
              </div>
            ) : null}
            {repoResultsQuery.isError ? (
              <p className="text-sm text-destructive">
                Failed to search repositories. Confirm the GitHub App can access
                the target repository.
              </p>
            ) : null}
            <details className="border border-border bg-card/30">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
                Advanced · Import the last {oldestDays} days
              </summary>
              <div className="border-t border-border p-4">
                <NumberField
                  className="[&>[role=group]]:rounded-none"
                  label="History window (days)"
                  description="Limits the initial Slack history import. New activity continues syncing after setup."
                  value={oldestDays}
                  onChange={(value) => setOldestDays(value || 90)}
                  minValue={1}
                  maxValue={3650}
                />
              </div>
            </details>
            <div className="flex justify-between border-t border-border pt-4">
              <Button
                variant="secondary"
                className="rounded-none"
                onPress={() => setManualDraftStep("channels")}
              >
                Back
              </Button>
              <Button
                className="rounded-none"
                isPending={saveMutation.isPending}
                isDisabled={!selectedRepo || saveMutation.isPending}
                onPress={() => saveMutation.mutate()}
              >
                Save & open config PR
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
