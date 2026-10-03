export function splitGitNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path.length > 0)
}

export function chatPullRequestPathIsSafe(path: string): boolean {
  if (path.startsWith("/") || path.includes("\0")) return false
  const parts = path.replaceAll("\\", "/").split("/")
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

const SESSION_BRANCH = /^ctxpipe\/chat\/[A-Za-z0-9._/-]+$/

export function isChatSessionBranch(branch: string): boolean {
  return SESSION_BRANCH.test(branch) && !branch.includes("..")
}
