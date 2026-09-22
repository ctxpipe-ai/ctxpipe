"use client"

import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { TextField } from "@/components/ui/TextField"
import { displayOAuthCallbackUrl } from "../lib/display-oauth-callback-url"
import {
  pagerdutyConnectorKeys,
  savePagerdutyOAuthApp,
} from "../queries/pagerduty-connector"

type PagerdutyRegisterOauthStepProps = {
  orgSlug: string
  connectionId: string
  oauthCallbackUrl: string
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

  const copy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 2000)
    }
  }

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
            aria-label={
              copyState === "copied" ? `${label} copied` : `Copy ${label}`
            }
            isDisabled={!value}
            onPress={() => void copy()}
          >
            {copyState === "copied" ? (
              <IconCheck className="h-4 w-4" aria-hidden />
            ) : (
              <IconCopy className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>
      {copyState === "error" ? (
        <output
          aria-live="polite"
          className="mt-1 block text-xs text-destructive"
        >
          Could not copy — copy the URL manually.
        </output>
      ) : null}
    </div>
  )
}

export function PagerdutyRegisterOauthStep({
  orgSlug,
  connectionId,
  oauthCallbackUrl,
}: PagerdutyRegisterOauthStepProps) {
  const queryClient = useQueryClient()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const callbackUrl = displayOAuthCallbackUrl(oauthCallbackUrl)

  const save = useMutation({
    mutationFn: () =>
      savePagerdutyOAuthApp(orgSlug, connectionId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      }),
    onSuccess: async () => {
      setClientSecret("")
      await queryClient.invalidateQueries({
        queryKey: pagerdutyConnectorKeys.status(orgSlug, connectionId),
      })
    },
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Register PagerDuty OAuth app
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Create a Scoped OAuth app for this deployment, then save its
          credentials here. ctxpipe creates the webhook subscription after you
          connect an account, so PagerDuty Events Integration stays off.
        </p>
      </div>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
        <li>
          Open{" "}
          <a
            href="https://developer.pagerduty.com/my-apps"
            className="font-medium text-teal-400 underline decoration-teal-400/50 underline-offset-4 hover:text-teal-300 hover:decoration-teal-300"
            target="_blank"
            rel="noreferrer"
          >
            PagerDuty App Registration
            <IconExternalLink className="ml-1 inline size-3.5" aria-hidden />
          </a>
          , select{" "}
          <strong className="font-medium text-foreground">New App</strong>, and
          name it{" "}
          <strong className="font-medium text-foreground">ctxpipe</strong> or
          after this deployment.
        </li>
        <li>
          Under{" "}
          <strong className="font-medium text-foreground">Functionality</strong>
          , select{" "}
          <strong className="font-medium text-foreground">OAuth 2.0</strong>.
          Leave{" "}
          <strong className="font-medium text-foreground">
            Events Integration
          </strong>{" "}
          unselected, then continue.
        </li>
        <li>
          Choose{" "}
          <strong className="font-medium text-foreground">Scoped OAuth</strong>{" "}
          and register this redirect URL exactly:
          <div className="mt-2">
            <CopyableUrl label="Redirect URL" value={callbackUrl} />
          </div>
        </li>
        <li>
          Grant only these permission scopes:
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              "incidents.read",
              "services.read",
              "users.read",
              "webhook_subscriptions.read",
              "webhook_subscriptions.write",
            ].map((scope) => (
              <code
                key={scope}
                className="rounded-none border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground"
              >
                {scope}
              </code>
            ))}
          </div>
        </li>
        <li>
          Select{" "}
          <strong className="font-medium text-foreground">Register App</strong>,
          then copy the generated client ID and client secret into the fields
          below. PagerDuty only shows the secret once.
        </li>
      </ol>
      <TextField
        label="Client ID"
        value={clientId}
        onChange={setClientId}
        autoComplete="off"
      />
      <TextField
        label="Client secret"
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        autoComplete="off"
      />
      <Button
        variant="primary"
        className="rounded-none"
        isPending={save.isPending}
        isDisabled={!clientId.trim() || !clientSecret.trim()}
        onPress={() => void save.mutateAsync()}
      >
        Save OAuth app
      </Button>
      {save.error ? (
        <InlineAlert variant="error" title="Could not save the OAuth app">
          {save.error.message} Check the client ID and secret, then try again.
        </InlineAlert>
      ) : null}
    </div>
  )
}
