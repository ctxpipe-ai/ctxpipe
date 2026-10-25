"use client"

import HyperDX from "@hyperdx/browser"
import { IconBrandSlack, IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"

import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchSlackConnectorStatus,
  fetchSlackOAuthStart,
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
  { id: "workspaces", label: "Choose Workspaces" },
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

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

  useEffect(() => {
    if (!isOpen) return
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

  // The pull requests that the add opened. A source, and so a capture,
  // starts only after its pull request merges.
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  if (!isOpen && pullRequests.length) setPullRequests([])

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
        HyperDX.addAction("connector_connect", { connector: "slack" })
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

  const status = statusQuery.data
  const setupStepIndex = getSlackSetupStepIndex(status)
  const setupView = getSlackSetupView({
    status,
    isPending: statusQuery.isPending,
    isError: statusQuery.isError,
  })

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
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Slack connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Save a Slack thread to your Workspaces when someone mentions the
                ctxpipe bot in it. The bot reads nothing else.
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
            className="rounded-md"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>

        {status && !statusQuery.isPending && !statusQuery.isError ? (
          <div className="mb-6">
            <ConnectorSetupStepper
              steps={SLACK_SETUP_STEPS}
              currentIndex={
                pullRequests.length ? SLACK_SETUP_STEPS.length : setupStepIndex
              }
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
                earlier, start a fresh authorization.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="rounded-md"
                isPending={statusQuery.isFetching}
                onPress={() => void statusQuery.refetch()}
              >
                Retry
              </Button>
              <Button
                className="rounded-md"
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
              className="rounded-md"
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
        ) : setupView === "workspaces" && pullRequests.length ? (
          <div className="space-y-4">
            <PullRequestsToMerge
              orgSlug={orgSlug}
              pullRequests={pullRequests}
              detail="The Slack source change applies after the merge. Until then, a mention in a new channel replies that no Workspace has the channel."
            />
            <Button
              variant="secondary"
              className="rounded-md"
              onPress={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        ) : setupView === "workspaces" && connectionId ? (
          <div className="flex flex-col gap-5">
            <section
              aria-label="How capture works"
              className="rounded-md border border-border bg-card/30 p-4 text-sm"
            >
              <h4 className="font-medium text-foreground">How capture works</h4>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  Below, select the Workspaces and the channels whose threads
                  they get.
                </li>
                <li>
                  In Slack, invite the bot to each channel with{" "}
                  <code className="rounded-md bg-muted px-1 py-0.5 text-[11px]">
                    /invite {formatSlackBotMention(status?.botHandle)}
                  </code>
                  .
                </li>
                <li>
                  In a thread of that channel, mention{" "}
                  <code className="rounded-md bg-muted px-1 py-0.5 text-[11px]">
                    {formatSlackBotMention(status?.botHandle)}
                  </code>
                  . ctxpipe saves the thread to each Workspace with that
                  channel.
                </li>
              </ol>
            </section>
            <AddToWorkspacesStep
              orgSlug={orgSlug}
              provider="slack"
              connectionId={connectionId}
              label="Slack"
              description="the channels for each"
              items="the channels"
              onDone={setPullRequests}
            />
          </div>
        ) : (
          <p className="text-sm text-destructive">
            The Slack connection identifier is missing. Close this dialog and
            reopen setup from the connector card.
          </p>
        )}
      </div>
    </Modal>
  )
}
