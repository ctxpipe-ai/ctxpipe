import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

import { Spinner } from "@/components/ui/spinner"
import { authClient } from "@/lib/auth-client"
import {
  GITHUB_SETUP_RESULT_KEY,
  getActiveGithubPopupFlowState,
  githubLinkErrorMessage,
  githubLinkPopupUrl,
  isGithubAppInstallUrl,
} from "@/lib/popup"

/**
 * The first page of the GitHub connect popup: link the user's GitHub
 * account if the user has none, then go on to the App install (`next`). The
 * backend attaches an installation only for a user whose linked GitHub
 * account can see it.
 */
export const Route = createFileRoute("/.github/link")({
  ssr: false,
  component: GithubLinkPage,
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
    linked: search.linked === "1" || search.linked === 1 ? "1" : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
})

function GithubLinkPage() {
  const search = Route.useSearch()
  return (
    <GithubLinkStep
      next={search.next}
      linked={search.linked === "1"}
      error={search.error}
    />
  )
}

/**
 * The page acts only for the connect flow that the opener started: `next`
 * must be a GitHub App install page whose `state` is the nonce of that flow.
 * So another site cannot use this page to link an account or to redirect.
 */
function flowNonceFor(next: string | undefined): string | null {
  if (next === undefined || !isGithubAppInstallUrl(next)) return null
  const flow = getActiveGithubPopupFlowState()
  const state = new URL(next).searchParams.get("state")
  return flow && state === flow.nonce ? flow.nonce : null
}

export function GithubLinkStep(props: {
  next: string | undefined
  linked: boolean
  error: string | undefined
}) {
  const { next, linked, error } = props
  const started = useRef(false)
  // Read once: the opener ends the flow when this popup closes.
  const [nonce] = useState(() => flowNonceFor(next))
  const valid = nonce !== null

  // Each step leaves this page, so it runs once per load.
  useEffect(() => {
    if (started.current || !valid || !next) return
    started.current = true
    if (error) {
      // The opener reads this when the popup closes, and shows the error.
      localStorage.setItem(
        GITHUB_SETUP_RESULT_KEY,
        JSON.stringify({ linkError: error, popupFlowNonce: nonce }),
      )
      window.close()
      return
    }
    if (linked) {
      window.location.replace(next)
      return
    }
    void (async () => {
      // Link only a user with no GitHub account. GitHub can skip its consent
      // screen, so a link here could add another GitHub account in silence.
      // If the list fails, go on: the backend still checks the account.
      const accounts = await authClient.listAccounts().then(
        (result) => result.data,
        () => null,
      )
      if (!accounts || accounts.some((a) => a.providerId === "github")) {
        window.location.replace(next)
        return
      }
      const back = githubLinkPopupUrl(next)
      await authClient.linkSocial({
        provider: "github",
        callbackURL: `${back}&linked=1`,
        errorCallbackURL: back,
      })
    })()
  }, [error, linked, next, nonce, valid])

  return (
    <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
      <header className="mb-8">
        <span className="ctx-label text-teal-400">GitHub</span>
      </header>
      {!valid ? (
        <p className="text-sm text-muted-foreground">
          This link is not valid. Close this window and connect GitHub again.
        </p>
      ) : error ? (
        <section>
          <h1 className="text-xl font-medium tracking-tight text-foreground">
            Could not link your GitHub account
          </h1>
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
            {githubLinkErrorMessage(error)}
          </p>
        </section>
      ) : (
        <p className="flex items-center gap-2 text-sm text-zinc-300">
          <Spinner className="text-zinc-400" />
          Connecting GitHub…
        </p>
      )}
    </main>
  )
}
