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
import { TextField } from "@/components/ui/TextField"
import { client } from "@/lib/api"
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
import { getSlackSetupStepIndex, getSlackSetupView } from "../slack-setup-model"
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
  const [repositoryId, setRepositoryId] = useState<string>("")
  const [repoSearch, setRepoSearch] = useState("")
  const [branch, setBranch] = useState("main")
  const [oldestDays, setOldestDays] = useState(90)
  const [showCompletion, setShowCompletion] = useState(false)

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

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

  useEffect(() => {
    const st = statusQuery.data
    if (!st) return
    if (st.syncTarget?.repositoryId) {
      setRepositoryId(st.syncTarget.repositoryId)
      setBranch(st.syncTarget.branch)
      const name = st.syncTarget.repositoryName
      if (name) setRepoSearch(name)
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
  }, [statusQuery.data])

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
      if (!repositoryId) throw new Error("Select a sync target repository")
      if (selected.size === 0) throw new Error("Select at least one channel")
      return patchSlackConnectorConfig(
        orgSlug,
        {
          channels: [...selected.values()].map((ch) => ({
            channelId: ch.id,
            name: ch.name,
            isPrivate: ch.isPrivate,
          })),
          syncTarget: {
            repositoryId,
            branch,
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
  const installed = status?.isInstalled === true
  const setupStepIndex = getSlackSetupStepIndex(
    status
      ? {
          ...status,
          selectedChannelCount: Math.max(
            selected.size,
            status.selectedChannelCount,
          ),
        }
      : undefined,
  )
  const setupView = getSlackSetupView({
    status,
    isPending: statusQuery.isPending,
    isError: statusQuery.isError,
    showCompletion,
  })

  const channels = channelsQuery.data ?? []
  const repos = reposQuery.data ?? []
  const setOpen = (open: boolean) => {
    if (!open) setShowCompletion(false)
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

        {installed ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={SLACK_SETUP_STEPS}
              currentIndex={setupStepIndex}
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
              <p className="text-sm text-muted-foreground">
                Pull request creation is taking longer than expected. Keep this
                dialog open while ctxpipe checks again.
              </p>
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
                onPress={() => setShowCompletion(false)}
              >
                Manage channels
              </Button>
              <Button className="rounded-none" onPress={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-medium text-foreground">
                  Select channels
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Connected to {status?.teamName ?? "Slack"}. In Slack, run{" "}
                  <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                    /invite
                  </code>
                  , choose the installed ctxpipe app, then refresh. Private
                  channels only appear after an invite. Your selection is
                  proposed in{" "}
                  <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                    slack/config.yaml
                  </code>
                  .
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
                    Failed to load Slack channels. Try again.
                  </p>
                ) : channels.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    No channels found. Invite the bot to a channel in Slack,
                    then refresh.
                  </p>
                ) : (
                  channels.map((ch) => (
                    <label
                      key={ch.id}
                      className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(ch.id)}
                        onChange={(event) => {
                          setSelected((prev) => {
                            const next = new Map(prev)
                            if (event.currentTarget.checked) next.set(ch.id, ch)
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
                        <span className="block text-xs uppercase text-muted-foreground">
                          {ch.isPrivate ? "private" : "public"}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              {selected.size > 0 ? (
                <div className="text-sm text-muted-foreground">
                  {selected.size} selected
                </div>
              ) : null}
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-base font-medium text-foreground">
                  Select a repository for Slack content
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Prefer a dedicated{" "}
                  <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                    ctxpipe-context
                  </code>{" "}
                  repository. Use a separate private repo if mirroring private
                  channels.
                </p>
              </div>
              {reposQuery.isPending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Loading repositories…
                </div>
              ) : repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No repositories in this organisation yet. Connect GitHub and
                  add a context repository first.
                </p>
              ) : (
                <ComboBox
                  label="Repository"
                  placeholder="Type to search repositories..."
                  selectedKey={repositoryId || null}
                  inputValue={
                    repos.find((r) => r.id === repositoryId)?.name ?? repoSearch
                  }
                  onInputChange={(value) => {
                    setRepoSearch(value)
                    if (
                      repositoryId &&
                      repos.find((r) => r.id === repositoryId)?.name !== value
                    ) {
                      setRepositoryId("")
                    }
                  }}
                  onSelectionChange={(key) => {
                    const id = key ? String(key) : ""
                    setRepositoryId(id)
                    const repo = repos.find((r) => r.id === id)
                    if (repo) setRepoSearch(repo.name)
                  }}
                  items={repos.filter((repo) =>
                    repo.name
                      .toLowerCase()
                      .includes(repoSearch.trim().toLowerCase()),
                  )}
                >
                  {(repo) => (
                    <ComboBoxItem id={repo.id} textValue={repo.name}>
                      {repo.name}
                    </ComboBoxItem>
                  )}
                </ComboBox>
              )}
              <TextField label="Branch" value={branch} onChange={setBranch} />
              <NumberField
                label="History window (days)"
                value={oldestDays}
                onChange={(value) => setOldestDays(value || 90)}
                minValue={1}
                maxValue={3650}
              />
            </div>

            <div className="flex justify-end border-t border-border pt-4">
              <Button
                className="rounded-none"
                isPending={saveMutation.isPending}
                isDisabled={
                  selected.size === 0 || !repositoryId || saveMutation.isPending
                }
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
