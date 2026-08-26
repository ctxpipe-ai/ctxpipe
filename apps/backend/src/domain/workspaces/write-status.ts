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
    "The GitHub App cannot write to this repository. Grant Contents: write so ctxpipe can push a conversation branch.",
  protectedBranch:
    "The default branch is protected. Jobs cannot push it; conversation chat can still push a session branch and open a pull request.",
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

/**
 * Binding classification only. GitHub + a connection is `unknown` until a
 * live permission probe (or a successful write) proves writable.
 */
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
  if (input.githubConnectionId) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.unknown,
      readOnlyReason: null,
    }
  }
  return {
    writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
    readOnlyReason: WRITE_STATUS_REASONS.githubNotConnected,
  }
}

export function isProtectedDefaultBranchGithubError(error: {
  status?: number
  message?: string
}): boolean {
  if (error.status !== 403) return false
  const message = (error.message ?? "").toLowerCase()
  return (
    message.includes("protected") ||
    message.includes("ruleset") ||
    message.includes("required status")
  )
}

/**
 * Maps a live GitHub error to Workspace writeStatus.
 * Protected default is not read-only: the App can still push a session branch.
 */
export function writeStatusFromGithubProbeError(error: {
  status?: number
  message?: string
}): WorkspaceWriteProbe {
  if (error.status === 404) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: WRITE_STATUS_REASONS.notInInstallation,
    }
  }
  if (isProtectedDefaultBranchGithubError(error)) {
    return writableWorkspaceWriteProbe()
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

export type GithubRepoPermissionBits = {
  admin?: boolean | null
  maintain?: boolean | null
  push?: boolean | null
  pull?: boolean | null
  contents?: string | boolean | null
}

/**
 * GitHub App installation tokens often expose `contents: "write"` instead of
 * the user-token `push` bit. Treat either as writable.
 */
export function githubInstallationCanPush(
  permissions: GithubRepoPermissionBits | null | undefined,
): boolean {
  if (!permissions) return false
  if (
    permissions.admin === true ||
    permissions.push === true ||
    permissions.maintain === true
  ) {
    return true
  }
  if (permissions.contents === true) return true
  if (typeof permissions.contents === "string") {
    const contents = permissions.contents.toLowerCase()
    return contents === "write" || contents === "admin"
  }
  return false
}

export type GithubRepoWriteView = {
  defaultBranch: string
  canPush: boolean
}

export type WorkspaceWriteProbeResult = WorkspaceWriteProbe & {
  defaultBranch: string | null
}

export type WorkspaceWriteViewFetcher = (input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
}) => Promise<GithubRepoWriteView>

/** Live GitHub permission/default-branch probe. Classification is not enough. */
/** Persist a live probe without downgrading writable to read_only on a miss. */
export function nextPersistedWriteProbe(input: {
  currentStatus: string
  probe: WorkspaceWriteProbe
}): WorkspaceWriteProbe {
  if (input.probe.writeStatus === WORKSPACE_WRITE_STATUSES.writable) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.writable,
      readOnlyReason: null,
    }
  }
  if (
    input.probe.writeStatus === WORKSPACE_WRITE_STATUSES.read_only &&
    input.probe.readOnlyReason === WRITE_STATUS_REASONS.notInInstallation &&
    input.currentStatus === WORKSPACE_WRITE_STATUSES.writable
  ) {
    return { writeStatus: WORKSPACE_WRITE_STATUSES.unknown, readOnlyReason: null }
  }
  if (input.probe.writeStatus === WORKSPACE_WRITE_STATUSES.read_only) {
    return {
      writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
      readOnlyReason: input.probe.readOnlyReason,
    }
  }
  return { writeStatus: WORKSPACE_WRITE_STATUSES.unknown, readOnlyReason: null }
}

export async function probeWorkspaceWriteAccess(input: {
  workspaceRepositoryUrl: string
  githubConnectionId: string | null | undefined
  orgId?: string
  fetchWriteView?: WorkspaceWriteViewFetcher
}): Promise<WorkspaceWriteProbeResult> {
  const classified = writeStatusFromClassification(input)
  if (classified.writeStatus !== WORKSPACE_WRITE_STATUSES.unknown) {
    return { ...classified, defaultBranch: null }
  }
  const repoFullName = githubRepoFullNameFromWorkspaceUrl(
    input.workspaceRepositoryUrl,
  )
  if (!repoFullName || !input.githubConnectionId) {
    return { ...classified, defaultBranch: null }
  }
  if (!input.fetchWriteView) {
    return { ...classified, defaultBranch: null }
  }
  if (!input.orgId) {
    return { ...classified, defaultBranch: null }
  }
  try {
    const view = await input.fetchWriteView({
      orgId: input.orgId,
      githubConnectionId: input.githubConnectionId,
      repoFullName,
    })
    if (!view.canPush) {
      return {
        writeStatus: WORKSPACE_WRITE_STATUSES.read_only,
        readOnlyReason: WRITE_STATUS_REASONS.contentsWriteDenied,
        defaultBranch: view.defaultBranch || null,
      }
    }
    return {
      ...writableWorkspaceWriteProbe(),
      defaultBranch: view.defaultBranch || null,
    }
  } catch (error) {
    return {
      ...writeStatusFromGithubProbeError(
        error as { status?: number; message?: string },
      ),
      defaultBranch: null,
    }
  }
}
