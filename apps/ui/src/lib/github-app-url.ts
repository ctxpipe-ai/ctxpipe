/**
 * GitHub App install flow: user picks which org/account to install the app onto.
 * `appSlug` is the public slug from `https://github.com/apps/<slug>`.
 */
export function githubAppInstallSelectTargetUrl(appSlug: string): string {
  const slug = appSlug.trim()
  if (!slug) {
    throw new Error("GitHub App slug is required for the install URL")
  }
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/select_target`
}

/**
 * When the deployment has no `hostedDefaultAppInstallUrl` from the API (no
 * platform GitHub App in env), fall back to ctxpipe’s default public app slug
 * so local/dev installs still work.
 */
export function fallbackCtxpipeHostedGithubAppInstallUrl(): string {
  if (typeof window === "undefined") {
    return githubAppInstallSelectTargetUrl("ctxpipe-agent")
  }
  const host = window.location.hostname
  const isLocalhost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.includes("localhost")
  const slug = isLocalhost ? "ctxpipe-agent-localhost" : "ctxpipe-agent"
  return githubAppInstallSelectTargetUrl(slug)
}

/** Prefer deploy-configured App install URL; otherwise public ctxpipe fallback. */
export function resolveGithubInstallPopupUrl(
  hostedDefaultAppInstallUrl: string | null | undefined,
): string {
  if (hostedDefaultAppInstallUrl) return hostedDefaultAppInstallUrl
  return fallbackCtxpipeHostedGithubAppInstallUrl()
}
