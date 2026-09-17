import type { GithubPrMirrorRepoConfig } from "./config-yaml.js"

export type GithubPrMirrorCandidate = {
  repository: string
  merged: boolean
  draft: boolean
  updatedAt: string
}

export function shouldMirrorGithubPullRequest(input: {
  config: GithubPrMirrorRepoConfig
  candidate: GithubPrMirrorCandidate
}): boolean {
  if (!input.config.repositories.includes(input.candidate.repository)) {
    return false
  }
  if (input.candidate.draft && !input.config.includeDrafts) {
    return false
  }
  const wantsMerged = input.config.states.includes("merged")
  const wantsOpen = input.config.states.includes("open")
  if (input.candidate.merged) {
    if (!wantsMerged) return false
  } else if (!wantsOpen) {
    return false
  }
  if (input.config.updatedSince) {
    const since = Date.parse(input.config.updatedSince)
    const updated = Date.parse(input.candidate.updatedAt)
    if (Number.isFinite(since) && Number.isFinite(updated) && updated < since) {
      return false
    }
  }
  return true
}
