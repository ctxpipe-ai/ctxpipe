export const CLONE_TOKEN_PERMISSIONS = {
  contents: "read" as const,
  metadata: "read" as const,
}

export function cloneRepositoryName(repoFullName: string): string {
  const trimmed = repoFullName.trim().replace(/\.git$/, "")
  const parts = trimmed.split("/").filter(Boolean)
  return parts.at(-1) ?? trimmed
}

/** Repo-scoped, contents:read installation token request. */
export function repoReadCloneTokenRequest(repoFullName: string): {
  type: "installation"
  repositoryNames: [string]
  permissions: typeof CLONE_TOKEN_PERMISSIONS
} {
  return {
    type: "installation",
    repositoryNames: [cloneRepositoryName(repoFullName)],
    permissions: CLONE_TOKEN_PERMISSIONS,
  }
}

export function originUrlWithoutCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return url
  }
}

export function scrubOriginAfterCloneCommand(url: string): string {
  return `git remote set-url origin ${originUrlWithoutCredentials(url)}`
}

export async function revokeGithubToken(token: string): Promise<void> {
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  })
  // 401: already expired or revoked.
  if (!response.ok && response.status !== 401)
    throw new Error(`GitHub token revoke failed with ${response.status}`)
}
