/**
 * GitHub App install flow: user picks which org/account to install the app onto.
 * `appSlug` is the public slug from `https://github.com/apps/<slug>`.
 */
export function githubAppInstallUrl(appSlug: string): string {
  const slug = appSlug.trim()
  if (!slug) {
    throw new Error("GitHub App slug is required for the install URL")
  }
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

/**
 * Grant-access links must use the App install URL. The raw installation
 * settings URL does not carry `state`, so GitHub cannot return to this app's
 * Setup URL with the popup nonce.
 */
export function githubGrantAccessUrls(args: {
  appSlug?: string | null
  manageUrl?: string | null
}): string[] {
  const slug = args.appSlug?.trim()
  if (slug) return [githubAppInstallUrl(slug)]
  return args.manageUrl ? [args.manageUrl] : []
}
