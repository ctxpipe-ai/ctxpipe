"use client"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Spinner } from "@/components/ui/spinner"
import { displayOAuthCallbackUrl } from "../../lib/display-oauth-callback-url"
import {
  fetchNotionOauthApp,
  notionConnectorKeys,
} from "../../queries/notion-connector"
import { CopyableUrl } from "./CopyableUrl"

type AddNotionWebhookStepProps = {
  orgSlug: string
  connectionId: string
  onContinue: () => void
}

export function AddNotionWebhookStep({
  orgSlug,
  connectionId,
  onContinue,
}: AddNotionWebhookStepProps) {
  const meta = useQuery({
    queryKey: notionConnectorKeys.oauthApp(orgSlug, connectionId),
    queryFn: () => fetchNotionOauthApp(orgSlug, connectionId),
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && !data.webhookVerificationToken) return 2000
      return false
    },
  })
  const webhookUrl = displayOAuthCallbackUrl(meta.data?.webhookUrl)
  const verificationToken = meta.data?.webhookVerificationToken ?? null
  const canContinue = Boolean(verificationToken)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">Add webhook</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          In the same Notion OAuth app, open the{" "}
          <strong className="font-medium text-foreground">Webhooks</strong> tab
          and add a webhook. Paste this event URL into{" "}
          <strong className="font-medium text-foreground">Webhook URL</strong>:
        </p>
        <CopyableUrl url={webhookUrl} label="event URL" />
      </div>
      {verificationToken ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste this{" "}
            <strong className="font-medium text-foreground">
              Verification token
            </strong>{" "}
            into Notion&apos;s{" "}
            <strong className="font-medium text-foreground">
              Verify subscription
            </strong>{" "}
            dialog, then click{" "}
            <strong className="font-medium text-foreground">
              Verify subscription
            </strong>
            .
          </p>
          <CopyableUrl url={verificationToken} label="verification token" />
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Spinner className="shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Waiting for Notion to send a verification token to that URL...
          </p>
        </div>
      )}
      {meta.isError ? (
        <InlineAlert variant="error" title="Could not load webhook settings">
          {meta.error instanceof Error
            ? meta.error.message
            : "Try again in a moment."}
        </InlineAlert>
      ) : null}
      <Button
        variant="primary"
        className="rounded-none"
        isDisabled={!canContinue}
        onPress={onContinue}
      >
        Continue
      </Button>
    </div>
  )
}
