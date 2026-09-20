"use client"

import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { TextField } from "@/components/ui/TextField"
import { displayOAuthCallbackUrl } from "../../lib/display-oauth-callback-url"
import {
  fetchNotionOauthApp,
  notionConnectorKeys,
  saveNotionOauthApp,
} from "../../queries/notion-connector"

type RegisterNotionOauthStepProps = {
  orgSlug: string
  connectionId: string
  onConnect: () => void
  connectPending?: boolean
}

function CopyableUrl({
  url,
  label,
}: {
  url?: string
  label: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )
  const display = url ?? "…"

  const onCopy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopyState("copied")
      window.setTimeout(() => setCopyState("idle"), 2000)
    } catch {
      setCopyState("error")
      window.setTimeout(() => setCopyState("idle"), 2000)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex w-full min-w-0 items-stretch overflow-hidden rounded-none border border-border bg-muted/50">
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
                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400"
                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary hover:bg-primary/10"
            }
            aria-label={
              copyState === "copied" ? `${label} copied` : `Copy ${label}`
            }
            isDisabled={!url}
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

export function RegisterNotionOauthStep({
  orgSlug,
  connectionId,
  onConnect,
  connectPending,
}: RegisterNotionOauthStepProps) {
  const queryClient = useQueryClient()
  const meta = useQuery({
    queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchNotionOauthApp(orgSlug, connectionId),
    refetchInterval: (query) => {
      const data = query.state.data
      if (data?.oauthAppSaved && !data.webhookConfigured) return 2000
      return false
    },
  })
  const [clientIdDraft, setClientIdDraft] = useState<string | null>(null)
  const [clientSecret, setClientSecret] = useState("")
  const clientId = clientIdDraft ?? meta.data?.oauthClientId ?? ""
  const saved = Boolean(meta.data?.oauthAppSaved)
  const webhookConfigured = Boolean(meta.data?.webhookConfigured)

  const save = useMutation({
    mutationFn: () =>
      saveNotionOauthApp(orgSlug, connectionId, {
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      }),
    onSuccess: async () => {
      setClientSecret("")
      await queryClient.invalidateQueries({
        queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId),
      })
    },
  })

  const callbackUrl = displayOAuthCallbackUrl(meta.data?.callbackUrl)
  const webhookUrl = displayOAuthCallbackUrl(meta.data?.webhookUrl)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Register Notion integration
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Self-hosted deployments use their own public Notion integration.
          Create it in Notion, save the client ID and secret here, then complete
          webhook verification before connecting a workspace.
        </p>
      </div>
      <div className="space-y-3">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
          <li>
            Create a{" "}
            <strong className="font-medium text-foreground">
              public integration
            </strong>{" "}
            in the{" "}
            <a
              href="https://www.notion.so/profile/integrations"
              className="text-primary underline-offset-2 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Notion integrations settings
              <IconExternalLink
                className="ml-1 inline size-3.5"
                aria-hidden
              />
            </a>
            , with public OAuth enabled.
          </li>
          <li>
            Register this callback URL in the integration:
            <CopyableUrl url={callbackUrl} label="callback URL" />
          </li>
          <li>
            Copy the integration{" "}
            <strong className="font-medium text-foreground">Client ID</strong>{" "}
            and{" "}
            <strong className="font-medium text-foreground">Client secret</strong>{" "}
            and paste them below.
          </li>
          {saved ? (
            <li>
              Paste this Event URL into the integration webhook settings, then
              complete Notion&apos;s one-time verification:
              <CopyableUrl url={webhookUrl} label="webhook URL" />
            </li>
          ) : null}
        </ol>
        <p className="text-sm text-muted-foreground">
          The client secret is stored encrypted and is never shown again after
          you save.
        </p>
        <TextField
          label="Client ID"
          value={clientId}
          onChange={setClientIdDraft}
          autoComplete="off"
        />
        <TextField
          label={saved ? "New client secret" : "Client secret"}
          value={clientSecret}
          onChange={setClientSecret}
          type="password"
          autoComplete="off"
          description={
            saved ? "Leave empty to keep the current secret." : undefined
          }
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            className="rounded-none"
            isPending={save.isPending}
            isDisabled={
              meta.isPending ||
              !clientId.trim() ||
              (!saved && !clientSecret.trim())
            }
            onPress={() => {
              void save.mutateAsync()
            }}
          >
            {saved ? "Update integration" : "Save integration"}
          </Button>
          {saved ? (
            <Button
              variant="secondary"
              className="rounded-none"
              isPending={connectPending}
              isDisabled={!webhookConfigured}
              onPress={onConnect}
            >
              Connect Notion
            </Button>
          ) : null}
        </div>
        {saved && !webhookConfigured ? (
          <p className="text-sm text-muted-foreground">
            Waiting for Notion to verify the Event URL. Connect stays disabled
            until verification succeeds.
          </p>
        ) : null}
        {save.error ? (
          <InlineAlert
            variant="error"
            title="Could not save the integration"
            actions={
              <Button
                variant="secondary"
                className="rounded-none"
                isPending={save.isPending}
                onPress={() => {
                  void save.mutateAsync()
                }}
              >
                Try again
              </Button>
            }
          >
            {save.error.message} Check the client ID and secret, then try again.
          </InlineAlert>
        ) : null}
      </div>
    </div>
  )
}
