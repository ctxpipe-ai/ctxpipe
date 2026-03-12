function isGitHubUrl(gitUrl: string): boolean {
  if (gitUrl.startsWith("git@github.com:")) return true
  try {
    const parsed = new URL(gitUrl)
    return parsed.hostname === "github.com"
  } catch {
    return false
  }
}

/**
 * Embeds an installation access token into a GitHub HTTPS URL using the
 * `x-access-token` scheme documented by GitHub for App installation tokens.
 * Returns the original URL unchanged for non-GitHub URLs or when no token is provided.
 */
export function authenticatedGitUrl(
  gitUrl: string,
  githubToken?: string,
): string {
  if (!githubToken || !isGitHubUrl(gitUrl)) return gitUrl
  const url = new URL(gitUrl)
  url.username = "x-access-token"
  url.password = githubToken
  return url.toString()
}
