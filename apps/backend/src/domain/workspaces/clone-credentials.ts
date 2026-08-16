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

export const JOB_SANDBOX_LIMITS = {
  vcpu: 1,
  memoryMib: 1024,
  pids: 128,
  diskGib: 4,
  nonRoot: true,
  privileged: false,
} as const

export function sandboxCanEnforceResourceLimits(provider: {
  isolation: "docker" | "local_process" | "railway"
}): {
  cpu: boolean
  ram: boolean
  pids: boolean
  disk: boolean
  user: boolean
  egress: boolean
} {
  if (provider.isolation !== "docker") {
    return {
      cpu: false,
      ram: false,
      pids: false,
      disk: false,
      user: false,
      egress: false,
    }
  }
  // Current TanStack dockerSandbox config has no HostConfig/user/egress fields.
  return {
    cpu: false,
    ram: false,
    pids: false,
    disk: false,
    user: false,
    egress: false,
  }
}
