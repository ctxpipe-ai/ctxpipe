/**
 * Closed, non-draft pull requests are mirrored: merged ones and ones closed
 * without a merge. Open pull requests are not. There is no per-Workspace setting.
 */
export function shouldMirrorGithubPullRequest(candidate: {
  state: "open" | "closed"
  merged: boolean
  draft: boolean
}): boolean {
  return (candidate.merged || candidate.state === "closed") && !candidate.draft
}
