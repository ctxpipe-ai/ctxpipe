import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { TextField } from "@/components/ui/TextField"
import { Textarea } from "@/components/ui/textarea"

export type GithubSelfHostedCredentialsStepProps = {
  githubAppId: string
  setGithubAppId: (v: string) => void
  appSlug: string
  setAppSlug: (v: string) => void
  privateKey: string
  setPrivateKey: (v: string) => void
  webhookSecret: string
  setWebhookSecret: (v: string) => void
  draftPending: boolean
  onSubmit: () => void
  onCancel: () => void
}

export function GithubSelfHostedCredentialsStep({
  githubAppId,
  setGithubAppId,
  appSlug,
  setAppSlug,
  privateKey,
  setPrivateKey,
  webhookSecret,
  setWebhookSecret,
  draftPending,
  onSubmit,
  onCancel,
}: GithubSelfHostedCredentialsStepProps) {
  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <InlineAlert variant="warning" title="Self-hosted connector">
        Credentials are encrypted with your deployment key and stored only in
        your database. Use the same webhook secret in GitHub App settings as
        you enter below.
      </InlineAlert>
      <TextField
        label="GitHub App ID"
        type="text"
        value={githubAppId}
        onChange={setGithubAppId}
        isRequired
        description="Numeric App ID from the GitHub App settings page."
      />
      <TextField
        label="App slug"
        type="text"
        value={appSlug}
        onChange={setAppSlug}
        isRequired
        description="Public slug in the app URL: github.com/apps/your-slug"
      />
      <div>
        <label
          htmlFor="gh-pem"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          Private key (PEM)
        </label>
        <Textarea
          id="gh-pem"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder="Paste the full PEM from GitHub App settings"
          className="min-h-32 font-mono text-xs"
          required
        />
      </div>
      <TextField
        label="Webhook secret"
        type="password"
        value={webhookSecret}
        onChange={setWebhookSecret}
        isRequired
        description="Generate a random secret; paste the same value into your GitHub App webhook settings."
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="secondary"
          className="rounded-none"
          onPress={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          className="rounded-none"
          isDisabled={draftPending}
        >
          Save and continue
        </Button>
      </div>
    </form>
  )
}
