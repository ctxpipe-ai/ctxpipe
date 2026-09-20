"use client"

import { IconCheck, IconCopy } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { displayOAuthCallbackUrl } from "../lib/display-oauth-callback-url"
import {
  fetchPagerdutyOAuthApp,
  pagerdutyConnectorKeys,
  savePagerdutyOAuthApp,
} from "../queries/pagerduty-connector"

type PagerdutyRegisterOauthStepProps = {
  orgSlug: string
  connectionId: string
}

function CopyableUrl({
  label,
  value,
}: {
  label: string
  value: string | undefined
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const display = value ?? "…"

  return (
    <div>
      <p className="text-sm font-medium text-foreground">{label}</p>
      <div className="mt-2 flex w-full min-w-0 items-stretch overflow-hidden rounded-none border border-border bg-muted/50">
        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
          <code className="break-all font-mono text-sm text-muted-foreground">
            {display}
          </code>
        </div>
        <div className="flex shrink-0 items-stretch border-l border-border">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={
              copyState === "copied"
                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary hover:bg-primary/10"
            }
            aria-label={copyState === "copied" ? `${label} copied` : `Copy ${label}`}
            isDisabled={!value}
            onPress={() => {
              if (!value) return
              void navigator.clipboard.writeText(value).then(
                () => {
                  setCopyState("copied")
                  window.setTimeout(() => setCopyState("idle"), 2000)
                },
                () => {
                  setCopyState("error")
                  window.setTimeout(() => setCopyState("idle"), 2000)
                },
              )
            }}
          >
            {copyState === "copied" ? (
              <IconCheck className="h-4 w-4" aria-hidden />
            ) : (
              <IconCopy className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PagerdutyRegisterOauthStep({
  orgSlug,
  connectionId,
}: PagerdutyRegisterOauthStepProps) {
  const queryClient = useQueryClient()
  const oauthQuery = useQuery({
    queryKey: pagerdutyConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchPagerdutyOAuthApp(orgSlug, connectionId),
  })
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const savedClientId = oauthQuery.data?.oauthClientId ?? ""
  const formClientId = clientId || savedClientId
  const callbackUrl = displayOAuthCallbackUrl(oauthQuery.data?.oauthCallbackUrl)
  const webhookUrl = displayOAuthCallbackUrl(oauthQuery.data?.webhookUrl)

  const save = useMutation({
    mutationFn: () =>
      savePagerdutyOAuthApp(orgSlug, connectionId, {
        clientId: formClientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      }),
    onSuccess: async () => {
      setClientSecret("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.oauthApp(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
        }),
      ])
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Register PagerDuty OAuth app
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Self-hosted deployments use their own Scoped OAuth app in the
          PagerDuty developer portal. Paste the callback and Event URL below,
          then save the client id and secret here. You do not need to restart
          the deployment.
        </p>
      </div>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
        <li>
          Create an OAuth application in the{" "}
          <a
            href="https://developer.pagerduty.com"
            className="text-primary underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            PagerDuty developer portal
          </a>
          .
        </li>
        <li>
          Register this callback URL exactly.
          <div className="mt-2">
            <CopyableUrl label="Callback URL" value={callbackUrl} />
          </div>
        </li>
        <li>
          Use this Event URL when PagerDuty asks for a webhook destination. ctx|
          creates the subscription after you connect an account.
          <div className="mt-2">
            <CopyableUrl label="Event URL" value={webhookUrl} />
          </div>
        </li>
      </ol>
      <TextField
        label="Client ID"
        value={formClientId}
        onChange={setClientId}
        autoComplete="off"
      />
      <TextField
        label={oauthQuery.data?.oauthAppSaved ? "New client secret" : "Client secret"}
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        autoComplete="off"
        description={
          oauthQuery.data?.oauthAppSaved
            ? "Leave empty to keep the current secret."
            : undefined
        }
      />
      <Button
        variant="primary"
        className="rounded-none"
        isPending={save.isPending}
        isDisabled={
          !formClientId.trim() ||
          (!oauthQuery.data?.oauthAppSaved && !clientSecret.trim())
        }
        onPress={() => void save.mutateAsync()}
      >
        {oauthQuery.data?.oauthAppSaved ? "Update OAuth app" : "Save OAuth app"}
      </Button>
      {save.error ? (
        <p className="text-sm text-destructive">{save.error.message}</p>
      ) : null}
      {oauthQuery.data?.oauthAppSaved ? (
        <p className="text-sm text-muted-foreground">
          OAuth app saved. Continue to connect a PagerDuty account. The client
          secret is never shown again.
        </p>
      ) : null}
    </div>
  )
}
