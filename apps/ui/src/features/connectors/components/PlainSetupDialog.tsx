"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PLAIN_REQUIRED_PERMISSIONS } from "backend/domain/workspace-sources/providers/plain"
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
import { getPlainSetupStep, PLAIN_SETUP_STEPS } from "../plain-setup-model"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  connectPlain,
  fetchPlainConnectorStatus,
  plainConnectorKeys,
} from "../queries/plain-connector"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { PlainMark } from "./PlainMark"

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

type PlainSetupDialogProps = {
  orgSlug: string
  connectionId?: string
  /** Open at the key step of a working connection, to add the webhook. */
  reconnect?: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

/**
 * Connect Plain with a machine-user API key, then add Plain to Workspaces
 * (ADR-050, ADR-056). ctx| creates the webhook target for live updates.
 */
export function PlainSetupDialog({
  orgSlug,
  connectionId,
  reconnect = false,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: PlainSetupDialogProps) {
  const queryClient = useQueryClient()
  const [reconnecting, setReconnecting] = useState(reconnect)
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0

  const statusQuery = useQuery({
    queryKey: plainConnectorKeys.status(orgSlug, connectionId ?? ""),
    queryFn: () => fetchPlainConnectorStatus(orgSlug, connectionId ?? ""),
    enabled: isOpen && Boolean(connectionId),
    retry: retryQuery,
  })
  const status = statusQuery.data
  const step = getPlainSetupStep(status, {
    workspacesDone,
    reconnect: reconnecting,
  })
  const stepIndex =
    step === "done"
      ? PLAIN_SETUP_STEPS.length
      : PLAIN_SETUP_STEPS.findIndex((candidate) => candidate.id === step)

  const body = (() => {
    if (connectionId && statusQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading the Plain connector
        </div>
      )
    }
    if (connectionId && (statusQuery.isError || !status)) {
      return (
        <div className="space-y-3">
          <InlineAlert variant="error">
            Could not load the Plain connector.
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
          revoked={status?.status === "revoked"}
          webhookMissing={status?.status === "installed"}
          onConnected={async (nextConnectionId) => {
            setReconnecting(false)
            onConnectionIdChange(nextConnectionId)
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: plainConnectorKeys.status(orgSlug, nextConnectionId),
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
    if (step === "workspaces") {
      return (
        <AddToWorkspacesStep
          orgSlug={orgSlug}
          provider="plain"
          connectionId={connectionId}
          label="Plain"
          description="the Help Centers and labels for each"
          items="the Help Centers and labels"
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
              <PlainMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Plain connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect Plain, then select the Help Centers and thread labels
                for each Workspace.
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
            steps={PLAIN_SETUP_STEPS}
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
  revoked: boolean
  /** A working connection without a webhook target: a reconnect adds it. */
  webhookMissing: boolean
  onConnected: (connectionId: string) => Promise<void>
}) {
  const [apiKey, setApiKey] = useState("")
  const connect = useMutation({
    mutationFn: () =>
      connectPlain(props.orgSlug, {
        apiKey: apiKey.trim(),
        ...(props.connectionId ? { connectionId: props.connectionId } : {}),
      }),
    onSuccess: async ({ connectionId }) => {
      setApiKey("")
      await props.onConnected(connectionId)
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">Connect Plain</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          In Plain, open{" "}
          <strong className="font-medium text-foreground">
            Settings → Machine Users
          </strong>
          , add a machine user for ctx|, and create an{" "}
          <ExternalLink href="https://www.plain.com/docs/graphql/authentication">
            API key
          </ExternalLink>{" "}
          with only these permissions. ctx| reads with the key, creates one
          webhook target for live updates, and keeps the key encrypted.
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {PLAIN_REQUIRED_PERMISSIONS.map((permission) => (
            <li key={permission}>
              <code className="font-mono text-xs text-foreground">
                {permission}
              </code>
            </li>
          ))}
        </ul>
      </div>
      {props.revoked ? (
        <InlineAlert variant="warning">
          Plain does not accept the saved key. Paste a new one.
        </InlineAlert>
      ) : props.webhookMissing ? (
        <InlineAlert variant="warning">
          Live updates are off. Paste the key again, and ctx| tries to add the
          webhook again.
        </InlineAlert>
      ) : null}
      <TextField
        label="API key"
        type="password"
        value={apiKey}
        onChange={setApiKey}
        autoComplete="off"
      />
      {connect.isError ? (
        <InlineAlert variant="error">{connect.error.message}</InlineAlert>
      ) : null}
      <Button
        variant="primary"
        className="rounded-md"
        isDisabled={!apiKey.trim()}
        isPending={connect.isPending}
        onPress={() => connect.mutate()}
      >
        Connect Plain
      </Button>
    </div>
  )
}
