"use client"

import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { TextField } from "@/components/ui/TextField"
import { displayOAuthCallbackUrl } from "../../lib/display-oauth-callback-url"
import {
  fetchLinearOauthApp,
  linearConnectorKeys,
  saveLinearOauthApp,
} from "../../queries/linear-connector"

type LinearOauthAppPanelProps = {
  orgSlug: string
  connectionId: string
}

function CopyableUrl({
  label,
  value,
}: {
  label: string
  value?: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const display = value ?? "…"

  const onCopy = async () => {
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
    <div className="mt-2">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="mt-1 flex w-full min-w-0 items-stretch overflow-hidden rounded-none border border-border bg-muted/50">
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
                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
            }
            aria-label={
              copyState === "copied" ? `${label} copied` : `Copy ${label}`
            }
            isDisabled={!value}
            onPress={() => void onCopy()}
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

export function LinearOauthAppPanel({
  orgSlug,
  connectionId,
}: LinearOauthAppPanelProps) {
  const queryClient = useQueryClient()
  const meta = useQuery({
    queryKey: linearConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchLinearOauthApp(orgSlug, connectionId),
  })
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [webhookSecret, setWebhookSecret] = useState("")

  const save = useMutation({
    mutationFn: () =>
      saveLinearOauthApp(orgSlug, connectionId, {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      }),
    onSuccess: async () => {
      setClientSecret("")
      setWebhookSecret("")
      await queryClient.invalidateQueries({
        queryKey: linearConnectorKeys.oauthApp(orgSlug, connectionId),
      })
    },
  })

  const callbackUrl = displayOAuthCallbackUrl(meta.data?.oauthCallbackUrl)
  const webhookUrl = displayOAuthCallbackUrl(meta.data?.linearWebhookUrl)
  const saved = Boolean(meta.data?.oauthAppSaved)

  return (
    <div className="space-y-3">
      {saved ? (
        <p className="text-sm text-muted-foreground">
          Client ID{" "}
          <code className="rounded-none bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {meta.data?.oauthClientId}
          </code>{" "}
          is saved. Leave secrets empty to keep the current values.
        </p>
      ) : (
        <div className="max-w-prose space-y-4 text-sm text-muted-foreground">
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                1
              </span>
              <p>
                Open{" "}
                <a
                  href={
                    meta.data?.linearCreateUrl ??
                    "https://linear.app/settings/api/applications/new"
                  }
                  className="inline-flex items-center gap-1 text-teal-400 underline decoration-teal-400/80 underline-offset-2 hover:text-teal-300 hover:decoration-teal-300"
                  target="_blank"
                  rel="noreferrer"
                >
                  Create new application
                  <IconExternalLink className="size-3.5" aria-hidden />
                </a>{" "}
                in Linear Settings → API.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                2
              </span>
              <div className="min-w-0 flex-1">
                <p>
                  Fill{" "}
                  <strong className="font-medium text-foreground">
                    Application name
                  </strong>{" "}
                  and{" "}
                  <strong className="font-medium text-foreground">
                    Developer name
                  </strong>
                  . Paste this URL into{" "}
                  <strong className="font-medium text-foreground">
                    Redirect URIs
                  </strong>
                  .
                </p>
                <CopyableUrl label="Redirect URIs" value={callbackUrl} />
              </div>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                3
              </span>
              <div className="min-w-0 flex-1">
                <p>
                  Turn{" "}
                  <strong className="font-medium text-foreground">
                    Webhooks
                  </strong>{" "}
                  on. Paste this URL into{" "}
                  <strong className="font-medium text-foreground">
                    Webhook URL
                  </strong>
                  . Copy{" "}
                  <strong className="font-medium text-foreground">
                    Webhook signing secret
                  </strong>{" "}
                  from that same form — Linear fills it in before you create.
                </p>
                <CopyableUrl label="Webhook URL" value={webhookUrl} />
                <p className="mt-2">
                  Under{" "}
                  <strong className="font-medium text-foreground">
                    Data change events
                  </strong>
                  , tick Issues, Comments, Documents, Projects, Initiatives, and
                  the related update and attachment boxes. Under{" "}
                  <strong className="font-medium text-foreground">
                    Authorization events
                  </strong>
                  , tick OAuth authorization events.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
                4
              </span>
              <p>
                Click{" "}
                <strong className="font-medium text-foreground">Create</strong>.
                Linear then shows{" "}
                <strong className="font-medium text-foreground">
                  Client ID
                </strong>{" "}
                and{" "}
                <strong className="font-medium text-foreground">
                  Client secret
                </strong>
                . Paste those plus the webhook signing secret into the fields
                below.
              </p>
            </li>
          </ol>
          <p>
            Secrets are stored encrypted and are not shown again after you save.
          </p>
        </div>
      )}
      <TextField
        label="Client ID"
        value={clientId}
        onChange={setClientId}
        autoComplete="off"
      />
      <TextField
        label={saved ? "New client secret" : "Client secret"}
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        autoComplete="off"
      />
      <TextField
        label={saved ? "New webhook signing secret" : "Webhook signing secret"}
        value={webhookSecret}
        onChange={setWebhookSecret}
        type="password"
        autoComplete="off"
      />
      <Button
        variant="primary"
        className="rounded-none"
        isPending={save.isPending}
        isDisabled={
          meta.isPending ||
          !clientId ||
          (!saved && (!clientSecret || !webhookSecret))
        }
        onPress={() => void save.mutateAsync()}
      >
        {saved ? "Update OAuth app" : "Save OAuth app"}
      </Button>
      {save.error ? (
        <InlineAlert variant="error" title="Could not save OAuth app">
          {save.error.message} Try again, or check the client ID and secrets.
        </InlineAlert>
      ) : null}
    </div>
  )
}
