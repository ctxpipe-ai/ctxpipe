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
            <p className="mt-2">
              Register a public Notion integration in the connector setup
              wizard. Choose <strong className="font-medium text-foreground">Add connection</strong>{" "}
              → <strong className="font-medium text-foreground">Notion</strong>,
              then save the client ID and secret on the{" "}
              <strong className="font-medium text-foreground">
                Register Notion integration
              </strong>{" "}
              step. The wizard shows the callback URL and Event URL. You do not
              need to set environment variables or restart.
            </p>
            {callbackUrl ? (
              <p className="mt-2">
                Callback URL for the public integration:
                <code className="mt-1 block break-all rounded-none bg-muted px-2 py-1 text-xs text-foreground">
                  {callbackUrl}
                </code>
              </p>
            ) : null}
            <p className="mt-2">
              See the{" "}
              <a
                href="https://docs.ctxpipe.ai/docs/self-hosting/notion"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                self-hosted Notion guide
                <IconExternalLink
                  className="ml-1 inline size-3.5"
                  aria-hidden
                />
              </a>{" "}
              for operator details.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  )
}
