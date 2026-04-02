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
