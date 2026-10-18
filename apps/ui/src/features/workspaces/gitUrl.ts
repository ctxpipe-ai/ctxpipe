/**
 * Compare installation clone URLs to stored workspace repository URLs.
 * GitHub names are not case-sensitive, and the stored URL can be in lowercase,
 * so the key is in lowercase.
 */
export function canonicalWorkspaceGitUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
}

/** True when the two git URLs name the same repository. */
export function sameGitUrl(a: string, b: string): boolean {
  return canonicalWorkspaceGitUrl(a) === canonicalWorkspaceGitUrl(b)
}

export function eligibleInstallationRepos<
  T extends { clone_url: string },
>(input: {
  repositories: T[]
  takenUrls: Iterable<string>
  currentUrl?: string
}): T[] {
  const taken = new Set(
    [...input.takenUrls].map((url) => canonicalWorkspaceGitUrl(url)),
  )
  const current = input.currentUrl
    ? canonicalWorkspaceGitUrl(input.currentUrl)
    : null
  return input.repositories.filter((repo) => {
    const url = canonicalWorkspaceGitUrl(repo.clone_url)
    if (current && url === current) return false
    return !taken.has(url)
  })
}
