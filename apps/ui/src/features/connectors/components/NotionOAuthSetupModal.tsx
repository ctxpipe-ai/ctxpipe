"use client"

import { IconExternalLink } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"

type NotionOAuthSetupModalProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function NotionOAuthSetupModal({
  isOpen,
  onOpenChange,
}: NotionOAuthSetupModalProps) {
  const callbackUrl =
    typeof window === "undefined"
      ? null
      : `${window.location.origin}/api/v1/connectors/notion/oauth/callback`

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      size="wide"
    >
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">
              Notion connector needs deployment setup
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This is an operator-level setup step. Once configured, each
              organisation can connect its Notion workspace with one click.
            </p>
          </div>
          <Button
            variant="secondary"
            className="shrink-0 rounded-none"
            onPress={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>

        <div className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <div>
            <h3 className="font-medium text-foreground">Hosted ctxpipe</h3>
            <p className="mt-2">
              The hosted service uses ctxpipe&apos;s shared Notion OAuth app. An
              administrator needs to configure that app on the backend
              deployment; end users should not create a Notion app or enter
              client secrets.
            </p>
          </div>

          <div>
            <h3 className="font-medium text-foreground">Self-hosted ctxpipe</h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>
                Create a public integration in the{" "}
                <a
                  href="https://www.notion.so/profile/integrations"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
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
                {callbackUrl ? (
                  <code className="mt-1 block break-all rounded-none bg-muted px-2 py-1 text-xs text-foreground">
                    {callbackUrl}
                  </code>
                ) : null}
              </li>
              <li>
                Set <code>NOTION_CLIENT_ID</code> and{" "}
                <code>NOTION_CLIENT_SECRET</code> in the backend environment,
                then restart the backend.
              </li>
            </ol>
          </div>
        </div>
      </div>
    </Modal>
  )
}
