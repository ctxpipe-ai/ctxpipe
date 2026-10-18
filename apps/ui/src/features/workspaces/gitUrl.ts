import { githubCloneUrlKey } from "@/features/repositories/githubRepoSelection"

export function eligibleInstallationRepos<
  T extends { clone_url: string },
>(input: {
  repositories: T[]
  takenUrls: Iterable<string>
  currentUrl?: string
}): T[] {
  const taken = new Set(
    [...input.takenUrls].map((url) => githubCloneUrlKey(url)),
  )
  const current = input.currentUrl ? githubCloneUrlKey(input.currentUrl) : null
  return input.repositories.filter((repo) => {
    const url = githubCloneUrlKey(repo.clone_url)
    if (current && url === current) return false
    return !taken.has(url)
  })
}
