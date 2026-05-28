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
 * GitHub App installation settings for an already-linked installation.
 * This opens the repository access settings directly for scope management.
 */
export function githubAppInstallationSettingsUrl(
  installationId: number,
): string {
  return `https://github.com/settings/installations/${installationId}`
}

/**
 * Dev-only convenience: when the API omits `hostedDefaultAppInstallUrl`, Storybook
 * and local runs can still open the public ctxpipe GitHub App. **Production**
 * self-hosted installs must use {@link useGithubConnectFlow} / the self-hosted
 * wizard instead of this URL.
 */
export function fallbackCtxpipeHostedGithubAppInstallUrl(): string {
  if (typeof window === "undefined") {
    return githubAppInstallSelectTargetUrl("ctxpipe-agent")
  }
  const host = window.location.hostname
  const isLocalhost =
    host === "localhost" || host === "127.0.0.1" || host.includes("localhost")
  const slug = isLocalhost ? "ctxpipe-agent-localhost" : "ctxpipe-agent"
  return githubAppInstallSelectTargetUrl(slug)
}

/**
 * Returns the managed App install URL when the deployment provides one.
 * Without a hosted URL: **null** in production; in `import.meta.env.DEV` only,
 * falls back to the public ctxpipe app slug for local ergonomics.
 */
export function resolveGithubInstallPopupUrl(
  hostedDefaultAppInstallUrl: string | null | undefined,
): string | null {
  if (hostedDefaultAppInstallUrl) return hostedDefaultAppInstallUrl
  if (import.meta.env.DEV) return fallbackCtxpipeHostedGithubAppInstallUrl()
  return null
}
