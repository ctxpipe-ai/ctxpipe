import { useState, type DragEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { CopyableBlock } from "../CopyableBlock"

export type GithubSelfHostedCredentialsStepProps = {
  githubAppId: string
  setGithubAppId: (v: string) => void
  appSlug: string
  setAppSlug: (v: string) => void
  privateKey: string
  setPrivateKey: (v: string) => void
  /** Generated in the browser; shown for copy/paste into GitHub only until the user saves. */
  generatedWebhookSecret: string
  /** Payload URL reserved for this connector (shown while creating the GitHub App). */
  payloadUrl: string | null
  payloadUrlLoading: boolean
  payloadUrlError: string | null
  draftPending: boolean
  saveDisabled?: boolean
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
  generatedWebhookSecret,
  payloadUrl,
  payloadUrlLoading,
  payloadUrlError,
  draftPending,
  saveDisabled = false,
  onSubmit,
  onCancel,
}: GithubSelfHostedCredentialsStepProps) {
  const [pemDropActive, setPemDropActive] = useState(false)

  const selfHostedDomain =
    typeof window !== "undefined"
      ? window.location.origin
      : null
  const callbackUrl = selfHostedDomain
    ? `${selfHostedDomain}/.auth/api/v1/auth/callback/github`
    : null
  const setupUrl = selfHostedDomain ? `${selfHostedDomain}/.github/setup` : null

  const onPemDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = "copy"
    if (e.dataTransfer.types.includes("Files")) setPemDropActive(true)
  }

  const onPemDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const next = e.relatedTarget as Node | null
    if (next == null || !e.currentTarget.contains(next)) {
      setPemDropActive(false)
    }
  }

  const onPemDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setPemDropActive(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".pem")) {
      toast.error("Drop a .pem file (GitHub private key download).")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : ""
      setPrivateKey(text.replace(/\r\n/g, "\n").trimEnd())
    }
    reader.onerror = () => {
      toast.error("Could not read that file.")
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Register your GitHub App
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Self-hosted deployments use a GitHub App you create under your own
          user account or organisation.
        </p>
        <ol className="mt-4 list-decimal space-y-6 pl-5 text-sm text-muted-foreground">
          <li>
            On GitHub, open{" "}
            <a
              href="https://github.com/settings/apps/new"
              className="text-primary underline-offset-2 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              New GitHub App (personal)
            </a>
            , or for an organisation: open the org →{" "}
            <strong className="font-medium text-foreground">Settings</strong> →{" "}
            <strong className="font-medium text-foreground">
              Developer settings
            </strong>{" "}
            →{" "}
            <strong className="font-medium text-foreground">GitHub Apps</strong>{" "}
            →{" "}
            <strong className="font-medium text-foreground">
              New GitHub App
            </strong>
            .
          </li>
          <li className="space-y-3">
            <p>
              On the{" "}
              <strong className="font-medium text-foreground">
                Register new GitHub App
              </strong>{" "}
              page, set each field as follows:
            </p>
            <dl className="space-y-4 pl-2">
              <div>
                <dt className="font-medium text-foreground">GitHub App name</dt>
                <dd className="mt-1">
                  Any name that identifies this app for your team.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Homepage URL</dt>
                <dd className="mt-1 space-y-2">
                  <p>Use your deployment domain.</p>
                  {selfHostedDomain != null ? (
                    <CopyableBlock
                      value={selfHostedDomain}
                      copiedAriaLabel="Homepage URL copied"
                      copyAriaLabel="Copy homepage URL"
                    />
                  ) : (
                    <p className="italic">
                      The URL appears after this dialog reserves a connector id.
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Identifying and authorizing users → Callback URL
                </dt>
                <dd className="mt-1 space-y-2">
                  <p>Add this Callback URL:</p>
                  {callbackUrl != null ? (
                    <CopyableBlock
                      value={callbackUrl}
                      copiedAriaLabel="Callback URL copied"
                      copyAriaLabel="Copy callback URL"
                    />
                  ) : (
                    <p className="italic">
                      The URL appears after this dialog reserves a connector id.
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Post installation → Setup URL
                </dt>
                <dd className="mt-1 space-y-2">
                  <p>Set Setup URL to:</p>
                  {setupUrl != null ? (
                    <CopyableBlock
                      value={setupUrl}
                      copiedAriaLabel="Setup URL copied"
                      copyAriaLabel="Copy setup URL"
                    />
                  ) : (
                    <p className="italic">
                      The URL appears after this dialog reserves a connector id.
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Post installation → Redirect on update
                </dt>
                <dd className="mt-1">
                  Tick{" "}
                  <strong className="font-medium text-foreground">
                    Redirect on update
                  </strong>{" "}
                  so users are sent back to the setup page after repository
                  selection changes.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Webhook → Active
                </dt>
                <dd className="mt-1">
                  Enable{" "}
                  <strong className="font-medium text-foreground">
                    Active
                  </strong>{" "}
                  so GitHub can deliver events.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Webhook → Webhook URL
                </dt>
                <dd className="mt-1 space-y-2">
                  {payloadUrlError != null ? (
                    <p className="text-destructive">{payloadUrlError}</p>
                  ) : null}
                  {payloadUrlLoading ? (
                    <p className="italic">Reserving Payload URL…</p>
                  ) : payloadUrl != null ? (
                    <CopyableBlock
                      value={payloadUrl}
                      copiedAriaLabel="Payload URL copied"
                      copyAriaLabel="Copy payload URL"
                    />
                  ) : (
                    <p className="italic">
                      The URL appears here after this dialog reserves a
                      connector id.
                    </p>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Webhook → Secret
                </dt>
                <dd className="mt-1 space-y-2">
                  <CopyableBlock
                    value={generatedWebhookSecret}
                    variant="secret"
                    copiedAriaLabel="Webhook secret copied"
                    copyAriaLabel="Copy webhook secret"
                    revealAriaLabel="Show webhook secret"
                    hideAriaLabel="Hide webhook secret"
                    copyErrorMessage="Could not copy — select the secret and copy manually."
                  />
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Permissions</dt>
                <dd className="mt-1">
                  <ul className="list-disc space-y-3 pl-5">
                    <li>
                      <strong className="font-medium text-foreground">
                        Repository permissions
                      </strong>
                      <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
                        <li>
                          <strong className="font-medium text-foreground">
                            Contents
                          </strong>
                          : Read and write
                        </li>
                        <li>
                          <strong className="font-medium text-foreground">
                            Pull requests
                          </strong>
                          : Read and write
                        </li>
                      </ul>
                    </li>
                    <li>
                      <strong className="font-medium text-foreground">
                        Account permissions
                      </strong>
                      <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
                        <li>
                          <strong className="font-medium text-foreground">
                            Email addresses
                          </strong>
                          : Read-only
                        </li>
                      </ul>
                    </li>
                  </ul>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Subscribe to Events
                </dt>
                <dd className="mt-1">
                  <ul className="list-disc space-y-1.5 pl-5">
                    <li>
                      <strong className="font-medium text-foreground">
                        Pull Request
                      </strong>
                    </li>
                    <li>
                      <strong className="font-medium text-foreground">
                        Push
                      </strong>
                    </li>
                    <li>
                      <strong className="font-medium text-foreground">
                        Repository
                      </strong>
                    </li>
                  </ul>
                </dd>
              </div>
            </dl>
          </li>
        </ol>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <TextField
          label="GitHub App ID"
          type="text"
          value={githubAppId}
          onChange={setGithubAppId}
          isRequired
          description="From the top of your GitHub App settings page (numeric)."
        />
        <TextField
          label="GitHub App slug"
          type="text"
          value={appSlug}
          onChange={setAppSlug}
          isRequired
          description="Exactly the slug from the address bar: https://github.com/settings/apps/&lt;slug&gt; or https://github.com/organizations/orgName/settings/apps/&lt;slug&gt;."
        />
        <div>
          <label
            htmlFor="gh-pem"
            className="mb-1.5 block text-sm font-medium text-foreground"
          >
            Private key (PEM)
          </label>
          <p className="mb-1.5 text-sm text-muted-foreground">
            From your app on GitHub:{" "}
            <strong className="font-medium text-foreground">
              Private keys
            </strong>{" "}
            section — entire PEM including BEGIN/END lines. You can also drop a
            downloaded{" "}
            <code className="rounded bg-muted/80 px-1 py-0.5 font-mono text-xs text-foreground">
              .pem
            </code>{" "}
            file here.
          </p>
          <div
            className={cn(
              "rounded-md transition-shadow",
              pemDropActive &&
                "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
            onDragEnter={(e) => {
              e.preventDefault()
              if (e.dataTransfer.types.includes("Files")) setPemDropActive(true)
            }}
            onDragLeave={onPemDragLeave}
            onDragOver={onPemDragOver}
            onDrop={onPemDrop}
          >
            <Textarea
              id="gh-pem"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              className="min-h-32 font-mono text-xs"
              required
            />
          </div>
        </div>
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
            isDisabled={draftPending || saveDisabled}
          >
            Install App
          </Button>
        </div>
      </form>
    </div>
  )
}
