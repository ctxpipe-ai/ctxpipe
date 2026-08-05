"use client"

import { IconBrandSlack, IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
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
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"

export const SLACK_SETUP_RESULT_KEY = "slack-setup-result"

const SLACK_DOCS_URL =
  "https://docs.ctxpipe.ai/docs/connections/source-connectors/slack"

const SLACK_SETUP_STEPS = [
  { id: "authorize", label: "Authorize Slack workspace" },
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
  const [branch, setBranch] = useState("main")
  const [oldestDays, setOldestDays] = useState(90)

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

  const statusQuery = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    enabled: isOpen,
    refetchInterval: 4000,
  })

  const channelsQuery = useQuery({
    queryKey: slackConnectorKeys.channels(orgSlug, connectionId),
    queryFn: () => fetchSlackAvailableChannels(orgSlug, connectionId),
    enabled: isOpen && Boolean(statusQuery.data?.isInstalled),
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
    enabled: isOpen && Boolean(statusQuery.data?.isInstalled),
  })

  useEffect(() => {
    const st = statusQuery.data
    if (!st) return
    if (st.syncTarget?.repositoryId) {
      setRepositoryId(st.syncTarget.repositoryId)
      setBranch(st.syncTarget.branch)
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
    onSuccess: (result) => {
      toast.success(
        result.configPrEnqueued
          ? "Opened a pull request for slack/config.yaml"
          : "Slack connector settings saved",
      )
      void queryClient.invalidateQueries({
        queryKey: orgConnectionsKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: slackConnectorKeys.status(orgSlug, connectionId),
      })
      onOpenChange(false)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Save failed")
    },
  })

  const status = statusQuery.data
  const installed = status?.isInstalled === true
  const channelCount = Math.max(
    selected.size,
    status?.selectedChannelCount ?? 0,
  )
  const setupStepIndex = !installed
    ? 0
    : channelCount === 0
      ? 1
      : !status?.syncTargetConfigured
        ? 2
        : status.setupPhase === "live"
          ? 4
          : 3

  const channels = channelsQuery.data ?? []

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
              <IconBrandSlack className="size-5 text-foreground" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Slack connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Mirror selected channels into a GitHub context repository
                through a reviewable{" "}
                <code className="bg-muted px-1 py-0.5 text-[11px]">
                  slack/config.yaml
                </code>{" "}
                pull request. Updates typically appear within about 10 minutes.
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
            onPress={() => onOpenChange(false)}
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

        <div className="flex flex-col gap-5">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Authorize workspace</h3>
            {installed ? (
              <p className="text-sm text-muted-foreground">
                Connected
                {status?.teamName ? ` to ${status.teamName}` : ""}.
              </p>
            ) : (
              <Button
                className="rounded-none"
                onPress={() => oauthMutation.mutate()}
                isDisabled={oauthMutation.isPending}
              >
                {oauthMutation.isPending ? (
                  <Spinner className="size-4" />
                ) : (
                  "Connect Slack"
                )}
              </Button>
            )}
          </section>

          {installed ? (
            <>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Select channels</h3>
                  <Button
                    variant="secondary"
                    className="rounded-none"
                    onPress={() => void channelsQuery.refetch()}
                    isDisabled={channelsQuery.isFetching}
                  >
                    {channelsQuery.isFetching ? (
                      <Spinner className="size-4" />
                    ) : (
                      "Refresh"
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only channels the bot has been invited to appear here. In
                  Slack, open a channel →{" "}
                  <code className="bg-muted px-1 py-0.5 text-[11px]">
                    /invite
                  </code>{" "}
                  and add the ctxpipe app, then refresh.
                </p>
                {channelsQuery.isPending ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Loading channels…
                  </div>
                ) : channelsQuery.isError ? (
                  <div className="border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    Could not load channels.{" "}
                    {channelsQuery.error instanceof Error
                      ? channelsQuery.error.message
                      : "Try Refresh."}
                  </div>
                ) : channels.length === 0 ? (
                  <div className="border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      No channels yet
                    </p>
                    <p className="mt-2">
                      The bot is connected to the workspace but is not a member
                      of any channels. Invite it to the channels you want to
                      mirror, then click Refresh.
                    </p>
                    <ol className="mt-3 list-decimal space-y-1 pl-5">
                      <li>Open the channel in Slack</li>
                      <li>
                        Run{" "}
                        <code className="bg-muted px-1 py-0.5 text-[11px]">
                          /invite @ctxpipe-dev
                        </code>{" "}
                        (use your app’s name if different)
                      </li>
                      <li>Return here and Refresh</li>
                    </ol>
                  </div>
                ) : (
                  <ul className="max-h-48 space-y-1 overflow-y-auto border border-border p-2">
                    {channels.map((ch) => {
                      const checked = selected.has(ch.id)
                      return (
                        <li key={ch.id}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setSelected((prev) => {
                                  const next = new Map(prev)
                                  if (next.has(ch.id)) next.delete(ch.id)
                                  else next.set(ch.id, ch)
                                  return next
                                })
                              }}
                            />
                            <span>
                              #{ch.name}
                              {ch.isPrivate ? (
                                <span className="ml-2 text-xs text-amber-400">
                                  private
                                </span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  Context repository & retention
                </h3>
                <p className="text-xs text-muted-foreground">
                  Prefer a dedicated{" "}
                  <code className="bg-muted px-1 py-0.5 text-[11px]">
                    ctxpipe-context
                  </code>{" "}
                  repo. Use a separate private repo if mirroring private Slack
                  channels.
                </p>
                <label className="block text-xs text-muted-foreground">
                  Repository
                  <select
                    className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={repositoryId}
                    onChange={(e) => setRepositoryId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {(reposQuery.data ?? []).map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                </label>
                {reposQuery.isSuccess &&
                (reposQuery.data?.length ?? 0) === 0 ? (
                  <p className="text-xs text-amber-400">
                    No repositories in this organisation yet. Add a GitHub
                    connector and register a context repository first.
                  </p>
                ) : null}
                <label className="block text-xs text-muted-foreground">
                  Branch
                  <input
                    className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </label>
                <label className="block text-xs text-muted-foreground">
                  History window (days)
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                    value={oldestDays}
                    onChange={(e) =>
                      setOldestDays(Number(e.target.value) || 90)
                    }
                  />
                </label>
              </section>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  className="rounded-none"
                  onPress={() => saveMutation.mutate()}
                  isDisabled={saveMutation.isPending}
                >
                  {saveMutation.isPending ? (
                    <Spinner className="size-4" />
                  ) : (
                    "Save & open config PR"
                  )}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
