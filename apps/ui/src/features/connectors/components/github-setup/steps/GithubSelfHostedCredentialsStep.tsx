import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react"
import { useState, type DragEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

type CopyState = "idle" | "copied" | "error"

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
  const [webhookCopyState, setWebhookCopyState] = useState<CopyState>("idle")
  const [payloadUrlCopyState, setPayloadUrlCopyState] =
    useState<CopyState>("idle")
  const [homepageUrlCopyState, setHomepageUrlCopyState] =
    useState<CopyState>("idle")
  const [callbackUrlCopyState, setCallbackUrlCopyState] =
    useState<CopyState>("idle")
  const [setupUrlCopyState, setSetupUrlCopyState] = useState<CopyState>("idle")
  const [webhookSecretVisible, setWebhookSecretVisible] = useState(false)
  const [pemDropActive, setPemDropActive] = useState(false)

  const selfHostedDomain =
    typeof window !== "undefined"
      ? window.location.origin
      : null
  const callbackUrl = selfHostedDomain
    ? `${selfHostedDomain}/.auth/api/v1/auth/callback/github`
    : null
  const setupUrl = selfHostedDomain ? `${selfHostedDomain}/.github/setup` : null

  const copyText = async (
    value: string | null,
    setState: (state: CopyState) => void,
  ) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setState("copied")
      window.setTimeout(() => setState("idle"), 2000)
    } catch {
      setState("error")
      window.setTimeout(() => setState("idle"), 2000)
    }
  }

  const copyPayloadUrl = async () => {
    await copyText(payloadUrl, setPayloadUrlCopyState)
  }

  const copyHomepageUrl = async () => {
    await copyText(selfHostedDomain, setHomepageUrlCopyState)
  }

  const copyCallbackUrl = async () => {
    await copyText(callbackUrl, setCallbackUrlCopyState)
  }

  const copySetupUrl = async () => {
    await copyText(setupUrl, setSetupUrlCopyState)
  }

  const copyGeneratedWebhookSecret = async () => {
    if (!generatedWebhookSecret) return
    try {
      await navigator.clipboard.writeText(generatedWebhookSecret)
      setWebhookCopyState("copied")
      window.setTimeout(() => setWebhookCopyState("idle"), 2000)
    } catch {
      setWebhookCopyState("error")
      window.setTimeout(() => setWebhookCopyState("idle"), 2000)
    }
  }

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
                    <>
                      <div
                        className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50"
                        role="group"
                        aria-label="Homepage URL. Use copy to paste into GitHub."
                      >
                        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
                          <code className="whitespace-nowrap font-mono text-sm text-muted-foreground">
                            {selfHostedDomain}
                          </code>
                        </div>
                        <div className="flex shrink-0 items-stretch border-l border-border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={
                              homepageUrlCopyState === "copied"
                                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
                            }
                            aria-label={
                              homepageUrlCopyState === "copied"
                                ? "Homepage URL copied"
                                : "Copy homepage URL"
                            }
                            title={
                              homepageUrlCopyState === "copied"
                                ? "Copied"
                                : homepageUrlCopyState === "error"
                                  ? "Copy failed"
                                  : "Copy homepage URL"
                            }
                            onPress={() => void copyHomepageUrl()}
                          >
                            {homepageUrlCopyState === "copied" ? (
                              <IconCheck
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            ) : (
                              <IconCopy
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            )}
                          </Button>
                        </div>
                      </div>
                      {homepageUrlCopyState === "error" ? (
                        <output
                          aria-live="polite"
                          className="block text-xs text-destructive"
                        >
                          Could not copy — copy the URL manually.
                        </output>
                      ) : null}
                    </>
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
                    <>
                      <div
                        className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50"
                        role="group"
                        aria-label="GitHub callback URL. Use copy to paste into GitHub."
                      >
                        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
                          <code className="whitespace-nowrap font-mono text-sm text-muted-foreground">
                            {callbackUrl}
                          </code>
                        </div>
                        <div className="flex shrink-0 items-stretch border-l border-border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={
                              callbackUrlCopyState === "copied"
                                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
                            }
                            aria-label={
                              callbackUrlCopyState === "copied"
                                ? "Callback URL copied"
                                : "Copy callback URL"
                            }
                            title={
                              callbackUrlCopyState === "copied"
                                ? "Copied"
                                : callbackUrlCopyState === "error"
                                  ? "Copy failed"
                                  : "Copy callback URL"
                            }
                            onPress={() => void copyCallbackUrl()}
                          >
                            {callbackUrlCopyState === "copied" ? (
                              <IconCheck
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            ) : (
                              <IconCopy
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            )}
                          </Button>
                        </div>
                      </div>
                      {callbackUrlCopyState === "error" ? (
                        <output
                          aria-live="polite"
                          className="block text-xs text-destructive"
                        >
                          Could not copy — copy the URL manually.
                        </output>
                      ) : null}
                    </>
                  ) : (
                    <p className="italic">
                      The URL appears after this dialog reserves a connector id.
                    </p>
                  )}
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
                    <>
                      <div
                        className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50"
                        role="group"
                        aria-label="Payload URL for this connector. Use copy to paste into GitHub."
                      >
                        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
                          <code className="whitespace-nowrap font-mono text-sm text-muted-foreground">
                            {payloadUrl}
                          </code>
                        </div>
                        <div className="flex shrink-0 items-stretch border-l border-border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={
                              payloadUrlCopyState === "copied"
                                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
                            }
                            aria-label={
                              payloadUrlCopyState === "copied"
                                ? "Payload URL copied"
                                : "Copy payload URL"
                            }
                            title={
                              payloadUrlCopyState === "copied"
                                ? "Copied"
                                : payloadUrlCopyState === "error"
                                  ? "Copy failed"
                                  : "Copy payload URL"
                            }
                            onPress={() => void copyPayloadUrl()}
                          >
                            {payloadUrlCopyState === "copied" ? (
                              <IconCheck
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            ) : (
                              <IconCopy
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            )}
                          </Button>
                        </div>
                      </div>
                      {payloadUrlCopyState === "error" ? (
                        <output
                          aria-live="polite"
                          className="block text-xs text-destructive"
                        >
                          Could not copy — copy the URL manually.
                        </output>
                      ) : null}
                    </>
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
                  <div
                    className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50"
                    role="group"
                    aria-label="Generated webhook secret. Reveal to view, or use the copy button for the full value."
                  >
                    <div className="flex min-h-10 min-w-0 flex-1 items-stretch">
                      <div
                        className={
                          webhookSecretVisible && generatedWebhookSecret
                            ? "min-w-0 flex-1 px-2 py-2 font-mono text-xs text-foreground"
                            : "flex min-h-10 min-w-0 flex-1 items-center px-2 font-mono text-xs text-foreground"
                        }
                      >
                        {generatedWebhookSecret ? (
                          webhookSecretVisible ? (
                            <span className="inline-block break-all select-text">
                              {generatedWebhookSecret}
                            </span>
                          ) : (
                            <span
                              className="block min-w-0 truncate select-none tracking-wider"
                              aria-hidden="true"
                            >
                              {"•".repeat(generatedWebhookSecret.length)}
                            </span>
                          )
                        ) : (
                          <span className="text-muted-foreground">…</span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-stretch border-l border-border">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="h-full min-h-10 w-10 shrink-0 rounded-none text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                          aria-label={
                            webhookSecretVisible
                              ? "Hide webhook secret"
                              : "Show webhook secret"
                          }
                          aria-pressed={webhookSecretVisible}
                          title={
                            webhookSecretVisible ? "Hide secret" : "Show secret"
                          }
                          isDisabled={!generatedWebhookSecret}
                          onPress={() => setWebhookSecretVisible((v) => !v)}
                        >
                          {webhookSecretVisible ? (
                            <IconEyeOff className="h-4 w-4" aria-hidden />
                          ) : (
                            <IconEye className="h-4 w-4" aria-hidden />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-stretch border-l border-border">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={
                          webhookCopyState === "copied"
                            ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                            : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
                        }
                        aria-label={
                          webhookCopyState === "copied"
                            ? "Webhook secret copied"
                            : "Copy webhook secret"
                        }
                        title={
                          webhookCopyState === "copied"
                            ? "Copied"
                            : webhookCopyState === "error"
                              ? "Copy failed"
                              : "Copy webhook secret"
                        }
                        isDisabled={!generatedWebhookSecret}
                        onPress={() => void copyGeneratedWebhookSecret()}
                      >
                        {webhookCopyState === "copied" ? (
                          <IconCheck
                            className="h-4 w-4 transition-opacity duration-200"
                            aria-hidden
                          />
                        ) : (
                          <IconCopy
                            className="h-4 w-4 transition-opacity duration-200"
                            aria-hidden
                          />
                        )}
                      </Button>
                    </div>
                  </div>
                  {webhookCopyState === "error" ? (
                    <output
                      aria-live="polite"
                      className="block text-xs text-destructive"
                    >
                      Could not copy — select the secret and copy manually.
                    </output>
                  ) : null}
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
              <div>
                <dt className="font-medium text-foreground">
                  Post installation → Setup URL
                </dt>
                <dd className="mt-1 space-y-2">
                  <p>Set Setup URL to:</p>
                  {setupUrl != null ? (
                    <>
                      <div
                        className="flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-muted/50"
                        role="group"
                        aria-label="GitHub post-install setup URL. Use copy to paste into GitHub."
                      >
                        <div className="flex min-h-10 min-w-0 flex-1 items-center overflow-x-auto px-2">
                          <code className="whitespace-nowrap font-mono text-sm text-muted-foreground">
                            {setupUrl}
                          </code>
                        </div>
                        <div className="flex shrink-0 items-stretch border-l border-border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={
                              setupUrlCopyState === "copied"
                                ? "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-emerald-600 transition-colors duration-200 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
                                : "h-full min-h-10 w-11 shrink-0 rounded-none px-0 text-primary transition-colors duration-200 hover:bg-primary/10 hover:text-primary pressed:bg-primary/15"
                            }
                            aria-label={
                              setupUrlCopyState === "copied"
                                ? "Setup URL copied"
                                : "Copy setup URL"
                            }
                            title={
                              setupUrlCopyState === "copied"
                                ? "Copied"
                                : setupUrlCopyState === "error"
                                  ? "Copy failed"
                                  : "Copy setup URL"
                            }
                            onPress={() => void copySetupUrl()}
                          >
                            {setupUrlCopyState === "copied" ? (
                              <IconCheck
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            ) : (
                              <IconCopy
                                className="h-4 w-4 transition-opacity duration-200"
                                aria-hidden
                              />
                            )}
                          </Button>
                        </div>
                      </div>
                      {setupUrlCopyState === "error" ? (
                        <output
                          aria-live="polite"
                          className="block text-xs text-destructive"
                        >
                          Could not copy — copy the URL manually.
                        </output>
                      ) : null}
                    </>
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
