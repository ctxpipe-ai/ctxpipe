import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

export const WORKSPACE_WRITE_STATUSES = {
  unknown: "unknown",
  writable: "writable",
  read_only: "read_only",
} as const

export type WorkspaceWriteStatus =
  (typeof WORKSPACE_WRITE_STATUSES)[keyof typeof WORKSPACE_WRITE_STATUSES]

export const WRITE_STATUS_REASONS = {
  nonGithubHost:
    "This remote is not GitHub. v1 can hydrate, search, and chat, but cannot commit or push. Relink to a GitHub repository the App can write.",
  githubNotConnected:
    "GitHub is not connected for this organisation. An owner or admin must install the GitHub App and add this repository to the installation.",
  notInInstallation:
    "This repository is not in the GitHub App installation. An installation owner or admin must add it, then refresh.",
  contentsWriteDenied:
    "The GitHub App cannot write to this repository. Grant Contents: write, or check branch protection — ctxpipe does not open a pull request.",
  protectedBranch:
    "The default branch is protected. ctxpipe commits directly and will not open a pull request. Relax protection for the App or relink.",
} as const

export type WorkspaceWriteProbe = {
  writeStatus: WorkspaceWriteStatus
  readOnlyReason: string | null
}

export function githubRepoFullNameFromWorkspaceUrl(url: string): string | null {
  const normalised = normalizeWorkspaceRepositoryUrl(url)
  try {
    const parsed = new URL(normalised)
    if (parsed.hostname.toLowerCase() !== "github.com") return null
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length < 2 || !parts[0] || !parts[1]) return null
    return `${parts[0]}/${parts[1]}`
  } catch {
    return null
  }
}

export function classifyWorkspaceWriteHost(url: string): "github" | "other" {
  return githubRepoFullNameFromWorkspaceUrl(url) ? "github" : "other"
}

/** Cheap probe used on create/relink. Live GitHub permission checks come later. */
export function writeStatusFromClassification(input: {
  workspaceRepositoryUrl: string
  githubConnectionId: string | null | undefined
}): WorkspaceWriteProbe {
  if (classifyWorkspaceWriteHost(input.workspaceRepositoryUrl) === "other") {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.nonGithubHost,
    }
  }
  if (!input.githubConnectionId) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
    }
  }
  return {
    writeStatus: WORKSPACE_WRITE_STATUSES.unknown,
    readOnlyReason: null,
  }
}

export function writeStatusFromGithubProbeError(error: {
  status?: number
  message?: string
}): WorkspaceWriteProbe {
  const message = (error.message ?? "").toLowerCase()
  if (error.status === 404) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.notInInstallation,
    }
  }
  if (
    error.status === 403 &&
    (message.includes("protected") ||
      message.includes("ruleset") ||
      message.includes("required status"))
  ) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.protectedBranch,
    }
  }
  if (error.status === 403) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.contentsWriteDenied,
    }
  }
  return {
    writeStatus: WORKSPACE_WRITE_STATUSES.unknown,
    readOnlyReason: null,
  }
}

export function githubConnectionIdForWriteProbe(input: {
  requested: string | null | undefined
  existing: string | null
}): string | null {
  if (input.requested !== undefined) return input.requested
  return input.existing
}

export function writableWorkspaceWriteProbe(): WorkspaceWriteProbe {
  return {
    writeStatus: WORKSPACE_WRITE_STATUSES.writable,
    readOnlyReason: null,
  }
}

export type GithubRepoWriteView = {
  defaultBranch: string
  canPush: boolean
}

export type WorkspaceWriteProbeResult = WorkspaceWriteProbe & {
  defaultBranch: string | null
}

/**
 * Classify first; if the remote might be writable, optionally ask GitHub.
 * Never assume the default branch is `main`.
 */
export async function probeWorkspaceWriteAccess(input: {
  workspaceRepositoryUrl: string
  githubConnectionId: string | null | undefined
  getRepo?: (fullName: string) => Promise<GithubRepoWriteView>
}): Promise<WorkspaceWriteProbeResult> {
  const classified = writeStatusFromClassification(input)
  if (classified.writeStatus !== WORKSPACE_WRITE_STATUSES.unknown) {
    return { ...classified, defaultBranch: null }
  }
  const fullName = githubRepoFullNameFromWorkspaceUrl(
    input.workspaceRepositoryUrl,
  )
  if (!fullName || !input.getRepo) {
    return { ...classified, defaultBranch: null }
  }
  try {
    const repo = await input.getRepo(fullName)
    if (!repo.canPush) {
      return {
        writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
        readOnlyReason: WRITE_STATUS_REASONS.contentsWriteDenied,
        defaultBranch: repo.defaultBranch,
      }
    }
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.writable,
      readOnlyReason: null,
      defaultBranch: repo.defaultBranch,
    }
  } catch (error) {
    const mapped = writeStatusFromGithubProbeError(
      error && typeof error === "object"
        ? (error as { status?: number; message?: string })
        : {},
    )
    return { ...mapped, defaultBranch: null }
  }
}
