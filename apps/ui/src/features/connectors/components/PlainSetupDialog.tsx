"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link } from "@/components/ui/Link"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { TextField } from "@/components/ui/TextField"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
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

const externalLink =
  "font-medium text-teal-400 underline decoration-teal-400/50 underline-offset-4 hover:text-teal-300 hover:decoration-teal-300"

/** The permissions of the machine-user API key, as the backend checks them. */
const KEY_PERMISSIONS = [
  "helpCenter:read",
  "labelType:read",
  "thread:read",
  "timeline:read",
  "customer:read",
  "user:read",
  "webhookTarget:create",
  "webhookTarget:delete",
]

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
 * (ADR-050, ADR-055). ctx| creates the webhook target for live updates.
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
  const [workspacesDone, setWorkspacesDone] = useState(false)
  const [pullRequestUrls, setPullRequestUrls] = useState<string[]>([])

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
        <div className="space-y-4">
          {status.webhookConfigured ? null : (
            <InlineAlert variant="warning">
              Live updates are off: Plain did not accept the webhook. Threads
              sync once a day and when you select Sync now.
            </InlineAlert>
          )}
          <AddToWorkspacesStep
            orgSlug={orgSlug}
            provider="plain"
            connectionId={connectionId}
            label="Plain"
            description="the Help Centers and labels for each"
            items="the Help Centers and labels"
            onDone={(urls) => {
              setPullRequestUrls(urls ?? [])
              setWorkspacesDone(true)
            }}
          />
        </div>
      )
    }
    return (
      <div className="space-y-4">
        {pullRequestUrls.length ? (
          <PullRequestsToMerge urls={pullRequestUrls} />
        ) : (
          <div>
            <h3 className="text-base font-medium text-foreground">
              Plain is connected
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Add Plain to a Workspace from the connector card, or change the
              Help Centers and labels of a Workspace in its settings.
            </p>
          </div>
        )}
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
          <Link
            href="https://www.plain.com/docs/graphql/authentication"
            className={externalLink}
            target="_blank"
            rel="noreferrer"
          >
            API key
            <IconExternalLink className="ml-1 inline size-3.5" aria-hidden />
          </Link>{" "}
          with only these permissions. ctx| reads with the key, creates one
          webhook target for live updates, and keeps the key encrypted.
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {KEY_PERMISSIONS.map((permission) => (
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
