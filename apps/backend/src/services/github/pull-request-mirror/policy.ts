/** Only merged, non-draft pull requests are mirrored. There is no per-Workspace setting. */
export function shouldMirrorGithubPullRequest(candidate: {
  merged: boolean
  draft: boolean
}): boolean {
  return candidate.merged && !candidate.draft
}
