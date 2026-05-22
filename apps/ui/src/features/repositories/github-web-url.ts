/** `owner/repo` when `gitUrl` points at github.com; otherwise null. */
export function githubRepoFullNameFromGitUrl(gitUrl: string): string | null {
  const web = githubWebUrl(gitUrl)
  if (!web) return null
  try {
    const u = new URL(web)
    const path = u.pathname.replace(/^\/+|\/+$/g, "")
    if (!path.includes("/")) return null
    return path
  } catch {
    return null
  }
}

/** Best-effort HTTPS GitHub URL for opening a repo in the browser. */
export function githubWebUrl(gitUrl: string): string | null {
  const trimmed = gitUrl.trim()
  if (!trimmed) return null
  if (/^https:\/\/github\.com\//i.test(trimmed)) {
    return trimmed.replace(/\.git$/i, "")
  }
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/i)
  if (ssh) {
    return `https://github.com/${ssh[1]}/${ssh[2]}`
  }
  return null
}
