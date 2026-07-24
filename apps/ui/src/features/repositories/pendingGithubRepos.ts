export type PendingConnectedGithubRepo = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
}

export type PendingSavedSetupRepo = {
  name: string
  gitUrl: string
}

export type PendingGithubSetupData = {
  ingestAllRepositories: boolean
  includeFutureRepos: boolean
  savedRepositories: PendingSavedSetupRepo[]
}

export function derivePendingGithubRepos({
  connectedGithubRepos,
  savedSetupRepos,
  existingGitUrls,
  setupData,
  setupPending,
}: {
  connectedGithubRepos: PendingConnectedGithubRepo[]
  savedSetupRepos: PendingSavedSetupRepo[]
  existingGitUrls: Set<string>
  setupData?: PendingGithubSetupData | null
  setupPending: boolean
}) {
  if (setupPending || !setupData) {
    return {
      pendingConnectedGithubRepos: [],
      pendingSavedSetupRepos: [],
    }
  }

  if (setupData.ingestAllRepositories) {
    return {
      pendingConnectedGithubRepos: connectedGithubRepos.filter(
        (repo) => !existingGitUrls.has(repo.clone_url),
      ),
      pendingSavedSetupRepos: [],
    }
  }

  return {
    pendingConnectedGithubRepos: [],
    pendingSavedSetupRepos: savedSetupRepos.filter(
      (repo) => !existingGitUrls.has(repo.gitUrl),
    ),
  }
}
