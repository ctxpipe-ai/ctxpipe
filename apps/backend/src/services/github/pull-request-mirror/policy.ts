/**
 * Closed, non-draft pull requests are mirrored: merged ones and ones closed
 * without a merge. Every source reports a merged pull request as `closed`.
 * There is no per-Workspace setting.
 */
export function shouldMirrorGithubPullRequest(candidate: {
  state: "open" | "closed"
  draft: boolean
}): boolean {
  return candidate.state === "closed" && !candidate.draft
}
