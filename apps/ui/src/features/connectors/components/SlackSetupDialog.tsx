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
import { Spinner } from "@/components/ui/spinner"
import { client } from "@/lib/api"
import { searchGithubInstallationRepos } from "../queries/atlassian-connector"
import {
  connectorSyncTargetKeys,
  fetchSuggestedConnectorSyncTarget,
} from "../queries/connector-sync-target"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "../queries/github-connector"
import {
  fetchOrgConnections,
  orgConnectionsKeys,
} from "../queries/org-connections"
import {
  fetchSlackConnectorStatus,
  fetchSlackOAuthStart,
  patchSlackConnectorConfig,
  SlackConnectionNotFoundError,
  SlackOAuthNotConfiguredError,
  slackConnectorKeys,
} from "../queries/slack-connector"
import { getSlackSetupStepIndex, getSlackSetupView } from "../slack-setup-model"
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
  { id: "target", label: "Choose context repository" },
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
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null)
  const [repoSearch, setRepoSearch] = useState("")
  const [debouncedRepoSearch, setDebouncedRepoSearch] = useState("")
  const [manualView, setManualView] = useState<"target" | null>(null)
  const [targetInitialized, setTargetInitialized] = useState(false)

  useEffect(() => {
    if (initialConnectionId) setConnectionId(initialConnectionId)
  }, [initialConnectionId])

  useEffect(() => {
    if (!isOpen) {
      setTargetInitialized(false)
      setSelectedRepo(null)
      setRepoSearch("")
      setManualView(null)
      return
    }
    // Opening "Add Slack" must not keep a deleted connectionId from a prior
    // OAuth in this dialog instance — that 404s status and blocks re-auth.
    setConnectionId(initialConnectionId)
  }, [isOpen, initialConnectionId])

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedRepoSearch(repoSearch), 300)
    return () => window.clearTimeout(id)
  }, [repoSearch])

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

  const { data: githubConnections = [] } = useQuery({
    queryKey: orgConnectionsKeys.list(orgSlug),
    queryFn: () => fetchOrgConnections(orgSlug),
    select: (connections) =>
      connections.filter((connection) => connection.type === "github"),
    enabled: isOpen && Boolean(statusQuery.data?.isGithubLinked),
  })

  const suggestedTargetQuery = useQuery({
    queryKey: connectorSyncTargetKeys.suggestion(orgSlug),
    queryFn: () => fetchSuggestedConnectorSyncTarget(orgSlug),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isGithubLinked) &&
      !statusQuery.data?.syncTarget,
  })

  const activeGithubConnectionId =
    statusQuery.data?.syncTarget?.githubConnectionId ??
    suggestedTargetQuery.data?.githubConnectionId ??
    (githubConnections.length === 1 ? githubConnections[0]?.id : undefined)

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
      activeGithubConnectionId,
    ],
    queryFn: () =>
      searchGithubInstallationRepos(
        orgSlug,
        debouncedRepoSearch,
        activeGithubConnectionId,
      ),
    enabled:
      isOpen &&
      Boolean(statusQuery.data?.isInstalled) &&
      Boolean(statusQuery.data?.isGithubLinked),
  })
  const githubInstallationQuery = useQuery({
    queryKey: githubConnectorKeys.installation(
      orgSlug,
      activeGithubConnectionId,
    ),
    queryFn: () =>
      fetchGithubInstallationSummary(orgSlug, activeGithubConnectionId),
    enabled: isOpen && Boolean(statusQuery.data?.isGithubLinked),
  })
  const createRepositoryUrl = getConnectorContextRepositoryCreateUrl(
    githubInstallationQuery.data?.accountSlug,
  )

  useEffect(() => {
    if (
      targetInitialized ||
      statusQuery.isPending ||
      (suggestedTargetQuery.isEnabled && suggestedTargetQuery.isPending)
    ) {
      return
    }
    const st = statusQuery.data?.syncTarget
    if (st) {
      const name = st.repositoryName
      const fromOrg = reposQuery.data?.find(
        (repo) => repo.id === st.repositoryId,
      )
      setSelectedRepo({
        id: 0,
        full_name: name,
        html_url:
          fromOrg?.gitUrl.replace(/\.git$/, "") ?? `https://github.com/${name}`,
        clone_url: fromOrg?.gitUrl ?? `https://github.com/${name}.git`,
        name: fromOrg?.name ?? name.split("/").pop() ?? name,
        default_branch: st.branch,
      })
      setRepoSearch(name)
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
      setRepoSearch(suggested.repositoryName)
    }
    setTargetInitialized(true)
  }, [
    reposQuery.data,
    statusQuery.data?.syncTarget,
    statusQuery.isPending,
    suggestedTargetQuery.data,
    suggestedTargetQuery.isEnabled,
    suggestedTargetQuery.isPending,
    targetInitialized,
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
      if (!selectedRepo) throw new Error("Select a context repository")
      const repository = reposQuery.data?.find(
        (repo) =>
          repo.gitUrl === selectedRepo.clone_url ||
          repo.name === selectedRepo.name ||
          repo.name === selectedRepo.full_name ||
          repo.gitUrl.replace(/\.git$/, "") ===
            selectedRepo.clone_url.replace(/\.git$/, ""),
      )
      return patchSlackConnectorConfig(
        orgSlug,
        {
          ...(repository
            ? { repositoryId: repository.id }
            : {
                repositoryName: selectedRepo.full_name,
                gitUrl: selectedRepo.clone_url,
                githubConnectionId: activeGithubConnectionId,
              }),
          branch: selectedRepo.default_branch,
        },
        connectionId,
      )
    },
    onSuccess: async () => {
      toast.success("Context repository saved. Slack capture is now live.")
      setManualView(null)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        }),
        queryClient.invalidateQueries({
          queryKey: ["slack-setup-repos", orgSlug],
        }),
        queryClient.invalidateQueries({
          queryKey: ["repositories", orgSlug],
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
                mentioning the ctxpipe bot.
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
                      /invite @ctxpipe
                    </code>
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                    2
                  </span>
                  <p>
                    In the thread, mention the bot — for example,{" "}
                    <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                      @ctxpipe please capture this thread
                    </code>
                    .
                  </p>
                </li>
              </ol>
              <p className="mt-3 text-sm text-muted-foreground">
                ctxpipe converts the thread to Markdown and commits it to your
                context repository. Mention the bot again on the same thread to
                refresh the snapshot with new replies.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="secondary"
                className="rounded-none"
                onPress={() => setManualView("target")}
              >
                Change repository
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
                Select a repository for Slack content
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose the context repository where captured Slack threads
                should be committed.
              </p>
            </div>
            <ConnectorContextRepositoryGuidance
              suggestedTarget={suggestedTargetQuery.data}
            />
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
                      {githubInstallationQuery.data?.accountSlug ? (
                        <>
                          {" "}
                          under{" "}
                          <code className="rounded-none bg-muted px-1 py-0.5 text-[11px]">
                            {githubInstallationQuery.data.accountSlug}
                          </code>
                        </>
                      ) : null}
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
            <div className="flex justify-between border-t border-border pt-4">
              {manualView === "target" && baseView === "live" ? (
                <Button
                  variant="secondary"
                  className="rounded-none"
                  onPress={() => setManualView(null)}
                >
                  Cancel
                </Button>
              ) : (
                <span />
              )}
              <Button
                className="rounded-none"
                isPending={saveMutation.isPending}
                isDisabled={!selectedRepo || saveMutation.isPending}
                onPress={() => saveMutation.mutate()}
              >
                {baseView === "live" ? "Save repository" : "Save & continue"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
