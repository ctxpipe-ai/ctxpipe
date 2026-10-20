"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { Spinner } from "@/components/ui/spinner"
import { TextField } from "@/components/ui/TextField"
import { AddToWorkspacesStep } from "@/features/workspace-sources/AddToWorkspacesStep"
import { PullRequestsToMerge } from "@/features/workspace-sources/PullRequestsToMerge"
import type { OpenedPullRequest } from "@/features/workspace-sources/useAddToWorkspaces"
import { retryQuery } from "@/lib/api-result"
import { displayOAuthCallbackUrl } from "../lib/display-oauth-callback-url"
import { orgConnectionsKeys } from "../queries/org-connections"
import {
  fetchZendeskConnectorStatus,
  fetchZendeskOAuthStart,
  saveZendeskOAuthClient,
  startZendeskSetup,
  type ZendeskConnectorStatus,
  zendeskConnectorKeys,
} from "../queries/zendesk-connector"
import {
  getZendeskSetupStep,
  getZendeskSetupSteps,
} from "../zendesk-setup-model"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"
import { CopyableUrl } from "./notion-setup/CopyableUrl"
import { ZendeskMark } from "./ZendeskMark"

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

type ZendeskSetupDialogProps = {
  orgSlug: string
  connectionId?: string
  /** Open at the connect step, to authorize again as a Zendesk admin. */
  reconnect?: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onConnectionIdChange: (connectionId: string) => void
}

/**
 * Connect a Zendesk account with OAuth, then add Zendesk to Workspaces
 * (ADR-050, ADR-055). A self-hosted deployment registers its own OAuth
 * client first; hosted ctx| has a global one.
 */
export function ZendeskSetupDialog({
  orgSlug,
  connectionId,
  reconnect = false,
  isOpen,
  onOpenChange,
  onConnectionIdChange,
}: ZendeskSetupDialogProps) {
  const queryClient = useQueryClient()
  const [pullRequests, setPullRequests] = useState<OpenedPullRequest[]>([])
  const workspacesDone = pullRequests.length > 0
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(reconnect)

  const statusQuery = useQuery({
    queryKey: zendeskConnectorKeys.status(orgSlug, connectionId ?? ""),
    queryFn: () => fetchZendeskConnectorStatus(orgSlug, connectionId ?? ""),
    enabled: isOpen && Boolean(connectionId),
    retry: retryQuery,
  })
  const status = statusQuery.data
  const step = getZendeskSetupStep(status, {
    workspacesDone,
    reconnect: reconnecting,
  })
  const steps = getZendeskSetupSteps(status?.deploymentOAuthClient ?? true)
  const stepIndex =
    step === "done"
      ? steps.length
      : steps.findIndex((candidate) => candidate.id === step)

  // The OAuth callback page sends its result with postMessage, and also
  // writes it to localStorage when the opener is gone.
  useEffect(() => {
    if (!isOpen) return
    const accept = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (data.orgSlug !== orgSlug) return
      if (data.type === "zendesk-oauth-error" && typeof data.error === "string")
        setOauthError(data.error)
      if (
        data.type === "zendesk-oauth-complete" &&
        typeof data.connectionId === "string"
      ) {
        setOauthError(null)
        setReconnecting(false)
        onConnectionIdChange(data.connectionId)
        void queryClient.invalidateQueries({
          queryKey: zendeskConnectorKeys.status(orgSlug, data.connectionId),
        })
        void queryClient.invalidateQueries({
          queryKey: orgConnectionsKeys.list(orgSlug),
        })
      }
    }
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin === window.location.origin) accept(event.data)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "zendesk-setup-result" || !event.newValue) return
      window.localStorage.removeItem("zendesk-setup-result")
      try {
        accept(JSON.parse(event.newValue) as unknown)
      } catch {
        // Only the signed callback page writes this key.
      }
    }
    window.addEventListener("message", onMessage)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("message", onMessage)
      window.removeEventListener("storage", onStorage)
    }
  }, [isOpen, orgSlug, onConnectionIdChange, queryClient])

  const refreshStatus = (id: string) =>
    queryClient.invalidateQueries({
      queryKey: zendeskConnectorKeys.status(orgSlug, id),
    })

  const body = (() => {
    if (connectionId && statusQuery.isPending) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading the Zendesk connector
        </div>
      )
    }
    if (connectionId && (statusQuery.isError || !status)) {
      return (
        <div className="space-y-3">
          <InlineAlert variant="error">
            Could not load the Zendesk connector.
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
    if (step === "account")
      return <AccountStep orgSlug={orgSlug} onStarted={onConnectionIdChange} />
    if (!connectionId || !status) return null
    if (step === "register")
      return (
        <RegisterStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          status={status}
          onSaved={() => void refreshStatus(connectionId)}
        />
      )
    if (step === "connect")
      return (
        <ConnectStep
          orgSlug={orgSlug}
          connectionId={connectionId}
          status={status}
          error={oauthError}
          onSkip={
            // A connected account can go on without the webhook.
            status.status === "installed"
              ? () => setReconnecting(false)
              : undefined
          }
        />
      )
    if (step === "workspaces")
      return (
        <div className="space-y-4">
          {status.webhookConfigured ? null : (
            <InlineAlert variant="warning">
              Zendesk did not let ctx| add the Help Center webhook, so articles
              sync once a day. Reconnect as a Zendesk admin to add it.
            </InlineAlert>
          )}
          <AddToWorkspacesStep
            orgSlug={orgSlug}
            provider="zendesk"
            connectionId={connectionId}
            label="Zendesk"
            description="the Help Center categories and ticket views for each"
            items="the categories and views"
            onDone={setPullRequests}
          />
        </div>
      )
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
              <ZendeskMark className="size-5 text-foreground" />
            </span>
            <div>
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Set up Zendesk connector
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect Zendesk, then select Help Center categories and ticket
                views for each Workspace.
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
          <ConnectorSetupStepper steps={steps} currentIndex={stepIndex} />
        </div>
        {body}
      </div>
    </Modal>
  )
}

function AccountStep(props: {
  orgSlug: string
  onStarted: (connectionId: string) => void
}) {
  const [subdomain, setSubdomain] = useState("")
  const start = useMutation({
    mutationFn: () =>
      startZendeskSetup(props.orgSlug, subdomain.trim().toLowerCase()),
    onSuccess: ({ connectionId }) => props.onStarted(connectionId),
  })
  return (
    <div className="space-y-4">
      <h3 className="text-base font-medium text-foreground">Zendesk account</h3>
      <TextField
        label="Zendesk subdomain"
        description="The name before .zendesk.com, for example acme in acme.zendesk.com."
        value={subdomain}
        onChange={setSubdomain}
        autoComplete="off"
      />
      {start.isError ? (
        <InlineAlert variant="error">{start.error.message}</InlineAlert>
      ) : null}
      <Button
        variant="primary"
        className="rounded-md"
        isDisabled={!subdomain.trim()}
        isPending={start.isPending}
        onPress={() => start.mutate()}
      >
        Continue
      </Button>
    </div>
  )
}

function RegisterStep(props: {
  orgSlug: string
  connectionId: string
  status: ZendeskConnectorStatus
  onSaved: () => void
}) {
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const save = useMutation({
    mutationFn: () =>
      saveZendeskOAuthClient(props.orgSlug, {
        connectionId: props.connectionId,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      }),
    onSuccess: () => {
      setClientSecret("")
      props.onSaved()
    },
  })
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Register an OAuth client
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This deployment has no Zendesk OAuth client. Add one in your Zendesk
          account. Only this deployment uses it.
        </p>
      </div>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
        <li>
          In{" "}
          <ExternalLink
            href={`https://${props.status.subdomain}.zendesk.com/admin/apps-integrations/apis/apis/oauth_clients`}
          >
            Admin Center, OAuth clients
          </ExternalLink>
          , add an OAuth client of the{" "}
          <strong className="font-medium text-foreground">Confidential</strong>{" "}
          kind.
        </li>
        <li>
          Add this redirect URL:
          <CopyableUrl
            url={displayOAuthCallbackUrl(props.status.redirectUri)}
            label="redirect URL"
          />
        </li>
        <li>
          Save the client, then paste its unique identifier and its secret here.
          Zendesk shows the secret one time.
        </li>
      </ol>
      <TextField
        label="Unique identifier"
        value={clientId}
        onChange={setClientId}
        autoComplete="off"
      />
      <TextField
        label="Secret"
        type="password"
        value={clientSecret}
        onChange={setClientSecret}
        autoComplete="off"
      />
      {save.isError ? (
        <InlineAlert variant="error">{save.error.message}</InlineAlert>
      ) : null}
      <Button
        variant="primary"
        className="rounded-md"
        isDisabled={!clientId.trim() || !clientSecret.trim()}
        isPending={save.isPending}
        onPress={() => save.mutate()}
      >
        Save OAuth client
      </Button>
    </div>
  )
}

function ConnectStep(props: {
  orgSlug: string
  connectionId: string
  status: ZendeskConnectorStatus
  error: string | null
  /** Go to the Workspaces step without a new authorization. */
  onSkip?: () => void
}) {
  const connect = useMutation({
    mutationFn: () => fetchZendeskOAuthStart(props.orgSlug, props.connectionId),
    onSuccess: ({ authorizationUrl }) => {
      const popup = window.open(
        authorizationUrl,
        "ctxpipe-zendesk-oauth",
        "popup,width=640,height=760",
      )
      if (!popup) toast.error("Allow pop-ups for this site, then try again.")
    },
  })
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Connect Zendesk
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {props.status.status === "revoked"
            ? "Zendesk does not accept the saved authorization. Connect again."
            : props.status.status === "installed"
              ? "Connect again as a Zendesk admin so ctx| can add the Help Center webhook."
              : "Approve read access to Help Center, tickets, views, and users. A Zendesk admin also lets ctx| add one webhook for Help Center changes."}
        </p>
      </div>
      {props.error ? (
        <InlineAlert variant="error">{props.error}</InlineAlert>
      ) : null}
      {connect.isError ? (
        <InlineAlert variant="error">{connect.error.message}</InlineAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          className="rounded-md"
          isPending={connect.isPending}
          onPress={() => connect.mutate()}
        >
          Connect Zendesk
        </Button>
        {props.onSkip ? (
          <Button
            variant="secondary"
            className="rounded-md"
            onPress={props.onSkip}
          >
            Skip to Workspaces
          </Button>
        ) : null}
      </div>
    </div>
  )
}
