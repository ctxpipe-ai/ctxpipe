import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { authClient } from "@/lib/auth-client"
import { githubLinkErrorMessage } from "@/lib/popup"

/**
 * Attaching an installation through the deployment's GitHub App needs a linked
 * GitHub account. Without GitHub sign-in on the deployment, the organization's
 * own App (the self-hosted wizard) is the only way in.
 */
export function GithubNotLinkedNotice({
  githubSignInEnabled,
  orgSlug,
  linkError,
}: {
  githubSignInEnabled: boolean
  orgSlug: string
  /** The error code of the last link attempt, from the `error` search parameter. */
  linkError?: string
}) {
  if (!githubSignInEnabled) {
    return (
      <section>
        <h1 className="text-3xl font-medium tracking-tight text-foreground">
          Use your organization's own GitHub App
        </h1>
        <p className="mt-3 text-sm text-zinc-400">
          GitHub sign-in is not enabled on this deployment, so ctx| cannot
          confirm that you can access this installation. Add a GitHub connection
          with your organization's own GitHub App from Connectors instead.
        </p>
        <div className="mt-6">
          <a
            href={`/${orgSlug}/connectors`}
            className="text-sm text-teal-400 underline underline-offset-4"
          >
            Open Connectors
          </a>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h1 className="text-3xl font-medium tracking-tight text-foreground">
        Connect your GitHub account to finish setup
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        To securely link this GitHub App installation, we need to verify that
        you have access to the GitHub App.
      </p>
      {linkError ? (
        <div className="mt-6">
          <InlineAlert
            variant="error"
            title="Could not link your GitHub account"
          >
            {githubLinkErrorMessage(linkError)}
          </InlineAlert>
        </div>
      ) : null}

      <div className="mt-6">
        <Button
          type="button"
          variant="primary"
          className="rounded-md"
          onPress={async () => {
            // Come back here with or without an error, never to Connectors.
            const search = new URLSearchParams(window.location.search)
            search.delete("error")
            search.delete("error_description")
            const back = `/.github/setup?${search}`
            await authClient.linkSocial({
              provider: "github",
              callbackURL: back,
              errorCallbackURL: back,
            })
          }}
        >
          Connect GitHub
        </Button>
      </div>
    </section>
  )
}
