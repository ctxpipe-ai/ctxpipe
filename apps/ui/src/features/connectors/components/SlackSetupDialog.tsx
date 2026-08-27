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
import { Modal } from "@/components/ui/Modal"
import { workspaceListOptions } from "@/features/workspaces/queries"
import type { Workspace } from "@/features/workspaces/types"
import {
  ConnectorWorkspaceDestinationPicker,
  destinationFromWorkspace,
  workspaceMatchingGitUrl,
} from "./ConnectorWorkspaceDestinationPicker"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchSlackConnectorStatus,
  fetchSlackOAuthStart,
  patchSlackConnectorConfig,
  SlackConnectionNotFoundError,
  SlackOAuthNotConfiguredError,
  slackConnectorKeys,
} from "../queries/slack-connector"
import {
  formatSlackBotMention,
  getSlackSetupStepIndex,
  getSlackSetupView,
} from "../slack-setup-model"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

export const SLACK_SETUP_RESULT_KEY = "slack-setup-result"

const SLACK_DOCS_URL =
  "https://docs.ctxpipe.ai/docs/connections/source-connectors/slack"

const SLACK_SETUP_STEPS = [
  { id: "authorize", label: "Authorize Slack workspace" },
  { id: "github", label: "Connect GitHub" },
  { id: "target", label: "Choose workspace" },
] as const

type SlackSetupDialogProps = {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  connectionId?: string
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
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null,
  )
  const [manualView, setManualView] = useState<"target" | null>(null)
  const [targetInitialized, setTargetInitialized] = useState(false)

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

  useEffect(() => {
    if (!isOpen) {
      setTargetInitialized(false)
      setSelectedWorkspace(null)
      setManualView(null)
      return
    }
    // Opening "Add Slack" must not keep a deleted connectionId from a prior
    // OAuth in this dialog instance — that 404s status and blocks re-auth.
    setConnectionId(initialConnectionId)
  }, [isOpen, initialConnectionId])

  const statusQuery = useQuery({
    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
    queryFn: () => fetchSlackConnectorStatus(orgSlug, connectionId),
    enabled: isOpen,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  })

  useEffect(() => {
    if (
      !isOpen ||
      !connectionId ||
      !(statusQuery.error instanceof SlackConnectionNotFoundError)
    ) {
      return
    }
    setConnectionId(undefined)
  }, [connectionId, isOpen, statusQuery.error])

  const workspacesQuery = useQuery({
    ...workspaceListOptions(orgSlug),
    enabled: isOpen && Boolean(statusQuery.data?.isGithubLinked),
  })

  useEffect(() => {
    if (targetInitialized || statusQuery.isPending || workspacesQuery.isPending) {
      return
    }
    const st = statusQuery.data?.syncTarget
    if (st) {
      setSelectedWorkspace(
        workspaceMatchingGitUrl(
          workspacesQuery.data?.items ?? [],
          `https://github.com/${st.repositoryName}.git`,
        ),
      )
    }
    setTargetInitialized(true)
  }, [
    statusQuery.data?.syncTarget,
    statusQuery.isPending,
    targetInitialized,
    workspacesQuery.data?.items,
    workspacesQuery.isPending,
  ])

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
      if (!selectedWorkspace) throw new Error("Select a workspace")
      const destination = destinationFromWorkspace(selectedWorkspace)
      return patchSlackConnectorConfig(
        orgSlug,
        {
          repositoryName: destination.repositoryName,
          gitUrl: destination.gitUrl,
          githubConnectionId: destination.githubConnectionId ?? undefined,
          branch: destination.branch,
        },
        connectionId,
      )
    },
    onSuccess: async () => {
      toast.success("Workspace destination saved. Slack capture is now live.")
      setManualView(null)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceListOptions(orgSlug).queryKey,
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
  const setupStepIndex = getSlackSetupStepIndex(status)
  const baseView = getSlackSetupView({
    status,
    isPending: statusQuery.isPending,
    isError: statusQuery.isError,
  })
  const setupView =
    manualView === "target" && baseView === "live" ? "target" : baseView
  const setupFocusOverride =
    setupView === "target" && baseView === "live" ? 2 : null

  const setOpen = (open: boolean) => {
    if (!open) setManualView(null)
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
                Capture specific Slack threads into a context repository by
                mentioning the bot.
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
                ctxpipe could not load this connection. If you removed Slack
                earlier, start a fresh authorisation.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="rounded-none"
                isPending={statusQuery.isFetching}
                onPress={() => void statusQuery.refetch()}
              >
                Retry
              </Button>
              <Button
                className="rounded-none"
                onPress={() => {
                  setConnectionId(undefined)
                  void queryClient.removeQueries({
                    queryKey: slackConnectorKeys.status(orgSlug, connectionId),
                  })
                }}
              >
                Start over
              </Button>
            </div>
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
        ) : setupView === "live" ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <IconCircleCheckFilled
                className="mt-0.5 size-5 shrink-0 text-emerald-500"
                aria-hidden
              />
              <div>
                <h3 className="text-base font-medium text-foreground">
                  Slack is connected
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Captured threads are committed to{" "}
                  <span className="text-foreground">
                    {status?.syncTarget?.repositoryName}
                  </span>
                  .
                </p>
              </div>
            </div>
            <div className="border border-border bg-card/30 p-4">
              <h4 className="text-sm font-medium text-foreground">
                How to capture a thread
              </h4>
              <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
                <li className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                    1
                  </span>
                  <p>
                    Invite the bot to the channel:{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      /invite {formatSlackBotMention(status?.botHandle)}
                    </code>
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                    2
                  </span>
                  <p>
                    Mention {formatSlackBotMention(status?.botHandle)} in an
                    existing thread to run ctx|. Say{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      capture this
                    </code>{" "}
                    or mention the bot with no extra text to snapshot the thread
                    into git. Later mentions on the same thread update the same
                    snapshot. Mention the bot in a thread, not at the top of the
                    channel.
                  </p>
                </li>
              </ol>
              <p className="mt-3 text-sm text-muted-foreground">
                Use this for decisions, incidents, and design debates you want
                as auditable engineering context. For live workspace search, use
                Slack MCP. Uninstalling the Slack app does not delete git
                history.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="secondary"
                className="rounded-none"
                onPress={() => setManualView("target")}
              >
                Change workspace
              </Button>
              <Button className="rounded-none" onPress={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-medium text-foreground">
                Select a workspace for Slack content
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Captured Slack threads are committed to that workspace
                repository.
              </p>
            </div>
            <ConnectorWorkspaceDestinationPicker
              orgSlug={orgSlug}
              selectedWorkspaceId={selectedWorkspace?.id ?? null}
              onSelect={setSelectedWorkspace}
            />
            <div className="flex justify-between border-t border-border pt-4">
              {manualView === "target" && baseView === "live" ? (
                <Button
                  variant="secondary"
                  className="rounded-md"
                  onPress={() => setManualView(null)}
                >
                  Cancel
                </Button>
              ) : (
                <span />
              )}
              <Button
                className="rounded-md"
                isPending={saveMutation.isPending}
                isDisabled={!selectedWorkspace || saveMutation.isPending}
                onPress={() => saveMutation.mutate()}
              >
                {baseView === "live" ? "Save workspace" : "Save & continue"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
