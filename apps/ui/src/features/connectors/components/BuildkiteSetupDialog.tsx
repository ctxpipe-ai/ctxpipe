"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { TextField } from "@/components/ui/TextField"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"
import { retryQuery } from "@/lib/api-result"

import {
  BUILDKITE_SETUP_STEPS,
  getBuildkiteSetupStep,
} from "../buildkite-setup-model"
import {
  type BuildkiteConnectorStatus,
  buildkiteConnectorKeys,
  connectBuildkite,
  fetchBuildkiteConnectorStatus,
  saveBuildkiteWebhookToken,
} from "../queries/buildkite-connector"
import { orgConnectionsKeys } from "../queries/org-connections"
import { BuildkiteMark } from "./BuildkiteMark"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { CopyableUrl } from "./notion-setup/CopyableUrl"

/** A link out of the product: teal, as the other setup dialogs show it. */
function ExternalLink(props: { href: string; children: string }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-teal-400 hover:text-teal-300"
    >
      {props.children}
      <IconExternalLink className="size-3.5" aria-hidden />
    </a>
  )
}

type BuildkiteSetupDialogProps = {
  orgSlug: string
  connectionId?: string
  /** Open at the webhook step to paste the token of the webhook again. */
  replaceWebhook?: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

/**
 * Connect Buildkite with an API access token, add the webhook, then add
 * Buildkite to Workspaces (ADR-050, ADR-057). The connection holds auth
 * only; each Workspace keeps its pipelines in its sources.
 */
export function BuildkiteSetupDialog({
  orgSlug,
  connectionId,
  replaceWebhook = false,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: BuildkiteSetupDialogProps) {
  const queryClient = useQueryClient()
  const [replacing, setReplacing] = useState(replaceWebhook)
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0

  const statusQuery = useQuery({
    queryKey: buildkiteConnectorKeys.status(orgSlug, connectionId ?? ""),
    queryFn: () => fetchBuildkiteConnectorStatus(orgSlug, connectionId ?? ""),
    enabled: isOpen && Boolean(connectionId),
    retry: retryQuery,
  })
  const status = statusQuery.data
  const step = getBuildkiteSetupStep(status, {
    workspacesDone,
    replaceWebhook: replacing,
  })
  const stepIndex =
    step === "done"
      ? BUILDKITE_SETUP_STEPS.length
      : BUILDKITE_SETUP_STEPS.findIndex((candidate) => candidate.id === step)

  const body = (() => {
    if (connectionId && statusQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading the Buildkite connector
        </div>
      )
    }
    if (connectionId && (statusQuery.isError || !status)) {
      return (
        <div className="space-y-3">
          <InlineAlert variant="error">
            Could not load the Buildkite connector.
          </InlineAlert>
          <Button
            variant="secondary"
            className="rounded-md"
            onPress={() => void statusQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )
    }
    if (step === "connect") {
      return (
        <ConnectStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          organizationSlug={status?.organizationSlug}
          revoked={status?.status === "revoked"}
          onConnected={async (nextConnectionId) => {
            onConnectionIdChange(nextConnectionId)
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: buildkiteConnectorKeys.status(
                  orgSlug,
                  nextConnectionId,
                ),
              }),
              queryClient.invalidateQueries({
                queryKey: orgConnectionsKeys.list(orgSlug),
              }),
            ])
          }}
        />
      )
    }
    if (!connectionId || !status) return null
    if (step === "webhook") {
      return (
        <WebhookStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          status={status}
          onSaved={() => setReplacing(false)}
        />
      )
    }
    if (step === "workspaces") {
      return (
        <AddToWorkspacesStep
          orgSlug={orgSlug}
          provider="buildkite"
          connectionId={connectionId}
          label="Buildkite"
          description="the pipelines for each"
          items="the pipelines"
          onDone={setPullRequests}
        />
      )
    }
    return (
      <div className="space-y-4">
        <PullRequestsToMerge orgSlug={orgSlug} pullRequests={pullRequests} />
        <Button
          variant="secondary"
          className="rounded-md"
          onPress={() => onOpenChange(false)}
        >
          Close
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
              <BuildkiteMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Buildkite connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect Buildkite, then select the pipelines for each Workspace.
              </p>
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
        <div className="mb-6">
          <ConnectorSetupStepper
            steps={BUILDKITE_SETUP_STEPS}
            currentIndex={stepIndex}
          />
        </div>
        {body}
      </div>
    </Modal>
  )
}

function ConnectStep(props: {
  orgSlug: string
  connectionId?: string
  organizationSlug?: string
  revoked: boolean
  onConnected: (connectionId: string) => Promise<void>
}) {
  const [organizationSlug, setOrganizationSlug] = useState(
    props.organizationSlug ?? "",
  )
  const [apiToken, setApiToken] = useState("")
  const connect = useMutation({
    mutationFn: () =>
      connectBuildkite(props.orgSlug, {
        organizationSlug: organizationSlug.trim(),
        apiToken: apiToken.trim(),
        ...(props.connectionId ? { connectionId: props.connectionId } : {}),
      }),
    onSuccess: async ({ connectionId }) => {
      setApiToken("")
      await props.onConnected(connectionId)
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Connect Buildkite
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Create an{" "}
          <ExternalLink href="https://buildkite.com/user/api-access-tokens/new">
            API access token
          </ExternalLink>{" "}
          for your organization with only the{" "}
          <code className="font-mono text-xs text-foreground">
            read_pipelines
          </code>{" "}
          and{" "}
          <code className="font-mono text-xs text-foreground">read_builds</code>{" "}
          scopes, and do not select GraphQL API access. ctx| refuses a token
          with more scopes or with GraphQL API access. It only reads with the
          token, and keeps it encrypted.
        </p>
      </div>
      {props.revoked ? (
        <InlineAlert variant="warning">
          Buildkite does not accept the saved token. Paste a new one.
        </InlineAlert>
      ) : null}
      <TextField
        label="Organization slug"
        description="The name in your Buildkite URL, for example acme in buildkite.com/acme."
        value={organizationSlug}
        onChange={setOrganizationSlug}
        isReadOnly={Boolean(props.connectionId)}
        autoComplete="off"
      />
      <TextField
        label="API access token"
        type="password"
        value={apiToken}
        onChange={setApiToken}
        autoComplete="off"
      />
      {connect.isError ? (
        <InlineAlert variant="error">{connect.error.message}</InlineAlert>
      ) : null}
      <Button
        variant="primary"
        className="rounded-md"
        isDisabled={!organizationSlug.trim() || !apiToken.trim()}
        isPending={connect.isPending}
        onPress={() => connect.mutate()}
      >
        Connect Buildkite
      </Button>
    </div>
  )
}

function WebhookStep(props: {
  orgSlug: string
  connectionId: string
  status: BuildkiteConnectorStatus
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [webhookToken, setWebhookToken] = useState("")
  const save = useMutation({
    mutationFn: () =>
      saveBuildkiteWebhookToken(props.orgSlug, {
        connectionId: props.connectionId,
        webhookToken: webhookToken.trim(),
      }),
    onSuccess: async () => {
      setWebhookToken("")
      props.onSaved()
      await queryClient.invalidateQueries({
        queryKey: buildkiteConnectorKeys.status(
          props.orgSlug,
          props.connectionId,
        ),
      })
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Add the Buildkite webhook
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          With the webhook, a finished build reaches the Workspaces in about 10
          minutes. To add it later, close this dialog: the connector card shows
          Add the webhook.
        </p>
      </div>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
        <li>
          In Buildkite, open{" "}
          <ExternalLink
            href={`https://buildkite.com/organizations/${encodeURIComponent(props.status.organizationSlug)}/services`}
          >
            Notification Services
          </ExternalLink>{" "}
          and add a{" "}
          <strong className="font-medium text-foreground">Webhook</strong>.
        </li>
        <li>
          <strong className="font-medium text-foreground">Webhook URL</strong>:
          paste this URL.
          <CopyableUrl url={props.status.webhookUrl} label="webhook URL" />
        </li>
        <li>
          <strong className="font-medium text-foreground">Token</strong>: select
          the signature option (
          <code className="font-mono text-xs text-foreground">
            X-Buildkite-Signature
          </code>
          ). ctx| refuses a plain token.
        </li>
        <li>
          <strong className="font-medium text-foreground">Events</strong>: Clear
          every event except{" "}
          <code className="font-mono text-xs text-foreground">
            build.finished
          </code>
          . ctx| uses only that event.
        </li>
        <li>
          <strong className="font-medium text-foreground">Pipelines</strong>:
          keep all pipelines, or select the pipelines that your Workspaces sync.
          Then save the webhook.
        </li>
        <li>Copy the token of the webhook, and paste it here.</li>
      </ol>
      <TextField
        label="Webhook token"
        type="password"
        value={webhookToken}
        onChange={setWebhookToken}
        autoComplete="off"
      />
      {save.isError ? (
        <InlineAlert variant="error">{save.error.message}</InlineAlert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          className="rounded-md"
          isDisabled={!webhookToken.trim()}
          isPending={save.isPending}
          onPress={() => save.mutate()}
        >
          Save webhook token
        </Button>
      </div>
    </div>
  )
}
