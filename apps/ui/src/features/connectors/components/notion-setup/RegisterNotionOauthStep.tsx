"use client"

import { IconExternalLink } from "@tabler/icons-react"
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
import { CopyableUrl } from "./CopyableUrl"

type RegisterNotionOauthStepProps = {
  orgSlug: string
  connectionId: string
  onSaved?: () => void
}

export function RegisterNotionOauthStep({
  orgSlug,
  connectionId,
  onSaved,
}: RegisterNotionOauthStepProps) {
  const queryClient = useQueryClient()
  const meta = useQuery({
    queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchNotionOauthApp(orgSlug, connectionId),
  })
  const [clientIdDraft, setClientIdDraft] = useState<string | null>(null)
  const [clientSecret, setClientSecret] = useState("")
  const clientId = clientIdDraft ?? meta.data?.oauthClientId ?? ""

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
      onSaved?.()
    },
  })

  const callbackUrl = displayOAuthCallbackUrl(meta.data?.callbackUrl)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Register Notion OAuth app
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          This deployment needs its own Notion OAuth app. An internal
          (token-only) integration will not work. For a private install, choose{" "}
          <strong className="font-medium text-foreground">
            Selected workspaces only
          </strong>{" "}
          — do not list on the Marketplace.
        </p>
      </div>
      <div className="space-y-3">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
          <li>
            Create an{" "}
            <strong className="font-medium text-foreground">OAuth app</strong>{" "}
            in the{" "}
            <a
              href="https://www.notion.so/profile/integrations"
              className="text-teal-400 underline underline-offset-4 hover:text-teal-300"
              target="_blank"
              rel="noreferrer"
            >
              Notion integrations
              <IconExternalLink
                className="ml-1 inline size-3.5"
                aria-hidden
              />
            </a>{" "}
            portal.
          </li>
          <li>
            Paste this{" "}
            <strong className="font-medium text-foreground">
              callback URL
            </strong>{" "}
            into the app&apos;s OAuth / redirect URI field:
            <CopyableUrl url={callbackUrl} label="callback URL" />
          </li>
          <li>
            Copy the{" "}
            <strong className="font-medium text-foreground">Client ID</strong>{" "}
            and{" "}
            <strong className="font-medium text-foreground">
              Client secret
            </strong>
            , paste them below, and save.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          After you save, you will add a webhook. The client secret is stored
          encrypted and is never shown again.
        </p>
        <TextField
          label="Client ID"
          value={clientId}
          onChange={setClientIdDraft}
          autoComplete="off"
        />
        <TextField
          label="Client secret"
          value={clientSecret}
          onChange={setClientSecret}
          type="password"
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            className="rounded-none"
            isPending={save.isPending}
            isDisabled={
              meta.isPending || !clientId.trim() || !clientSecret.trim()
            }
            onPress={() => {
              void save.mutateAsync()
            }}
          >
            Save
          </Button>
        </div>
        {save.error ? (
          <InlineAlert
            variant="error"
            title="Could not save the OAuth app"
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
