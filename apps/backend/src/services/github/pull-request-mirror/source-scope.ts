export function isCtxpipeContextRepositoryName(name: string): boolean {
  const repo = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return repo === "ctxpipe-context"
}

export function sourceRepositoriesForPrMirror(
  repositoryNames: string[],
  contextRepositoryName: string,
): string[] {
  return [...new Set(repositoryNames)]
    .filter(
      (name) =>
        name !== contextRepositoryName && !isCtxpipeContextRepositoryName(name),
    )
    .sort((a, b) => a.localeCompare(b))
}

export type GithubPrMirrorTargetCandidate = {
  repositoryId: string
  repositoryName: string
  branch: string
}

export function pickGithubPrMirrorTarget(input: {
  existing: GithubPrMirrorTargetCandidate | null
  connectorTargets: GithubPrMirrorTargetCandidate[]
  ctxpipeContextRepos: GithubPrMirrorTargetCandidate[]
}): GithubPrMirrorTargetCandidate | null {
  if (input.existing) return input.existing
  if (input.connectorTargets[0]) return input.connectorTargets[0]
  return input.ctxpipeContextRepos[0] ?? null
}
