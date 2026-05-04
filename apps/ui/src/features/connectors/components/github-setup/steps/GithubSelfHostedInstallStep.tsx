import { Button } from "@/components/ui/Button"

export type GithubSelfHostedInstallStepProps = {
  webhookUrl: string | null
  onBack: () => void
  onOpenGitHubInstall: () => void
}

export function GithubSelfHostedInstallStep({
  webhookUrl,
  onBack,
  onOpenGitHubInstall,
}: GithubSelfHostedInstallStepProps) {
  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-md border border-border bg-card/40 p-4 text-sm">
        <p className="font-medium text-foreground">1. Webhook URL</p>
        <p className="mt-1 text-muted-foreground">
          In your GitHub App settings, set the webhook URL to:
        </p>
        {webhookUrl ? (
          <code className="mt-2 block break-all rounded bg-muted/50 p-2 text-xs text-foreground">
            {webhookUrl}
          </code>
        ) : null}
      </div>
      <div className="rounded-md border border-border bg-card/40 p-4 text-sm">
        <p className="font-medium text-foreground">
          2. Install the app on your account
        </p>
        <p className="mt-1 text-muted-foreground">
          Use the button below to open GitHub, choose where to install, then
          finish in the popup so we can link the installation.
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="secondary"
          className="rounded-none"
          onPress={onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          className="rounded-none"
          onPress={onOpenGitHubInstall}
        >
          Open GitHub to install
        </Button>
      </div>
    </div>
  )
}
