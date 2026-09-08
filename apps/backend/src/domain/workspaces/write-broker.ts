import type { Env } from "../../config/env.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { persistSemanticHandoff } from "../../models/workspace-write-jobs.js"
import {
  getWorkspaceWriteAdmission,
  persistWriteStatus,
} from "../../models/workspaces.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import {
  type GitPack,
  nativeGit,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  assertConnectorMirrorBinding,
  assertConnectorMirrorScope,
  type ConnectorMirrorSource,
} from "./connector-mirror.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  WRITE_STATUS_REASONS,
} from "./write-status.js"

class WorkspaceTipAdvancedError extends Error {
  constructor() {
    super("Default branch advanced; semantic merge is required")
  }
}

class WorkspaceWriteAccessUnavailableError extends Error {
  constructor(readonly readOnlyReason?: string) {
    super("Workspace default-branch write access is unavailable")
  }
}

/** Only a recognized remote access/protection denial pauses a native push. */
function writeAccessDenialReason(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const detail = error as { status?: number; stderr?: Buffer | string }
  const stderr = detail.stderr?.toString() ?? ""
  if (
    /GH006:|GH013:|protected branch update failed|repository rule violations/i.test(
      stderr,
    )
  )
    return WRITE_STATUS_REASONS.protectedBranch
  if (
    detail.status === 401 ||
    detail.status === 403 ||
    detail.status === 404 ||
    /permission to .+ denied|requested URL returned error: (?:401|403)|authentication failed/i.test(
      stderr,
    )
  )
    return WRITE_STATUS_REASONS.contentsWriteDenied
  return null
}

/** Called inside the workflow's durable broker-push step. Credentials never leave it. */
export async function pushWorkspaceCommit(
  input: { orgId: string; workspaceId: string; mirror?: ConnectorMirrorSource },
  revision: WorkspaceRevision,
  committed: GitPack,
  env: Env,
): Promise<void> {
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    throw new Error("Workspace writes require a connected GitHub repository")
  const workspace = await getWorkspaceWriteAdmission(input.workspaceId)
  const current = workspace?.revision ?? null
  if (!workspace || !sameWriteBinding(current, revision))
    throw new Error("Workspace write binding changed before push")
  const readToken = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const tip = await resolveGitRemoteTip({
    url: revision.remote.url,
    token: readToken,
  })
  if (tip?.branch !== revision.defaultBranch)
    throw new Error("Default branch changed before push")
  if (await remoteContainsCommit(revision, committed, tip.sha, readToken))
    return
  if (workspace.writeStatus !== "writable")
    throw new WorkspaceWriteAccessUnavailableError()
  if (tip.sha !== revision.sha || !sameWorkspaceRevision(current, revision))
    throw new WorkspaceTipAdvancedError()
  if (input.mirror) {
    await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
    await assertConnectorMirrorScope(input.mirror, committed)
  }
  const token = await getRepoWriteCloneToken(input.orgId, env, {
    githubConnectionId: connectionId,
    repoFullName: repositoryName,
  }).catch((error: unknown) => {
    const reason = writeAccessDenialReason(error)
    if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
    throw error
  })
  if (!token)
    throw new WorkspaceWriteAccessUnavailableError(
      WRITE_STATUS_REASONS.contentsWriteDenied,
    )
  await withGitDirectory(
    committed.sha,
    async (directory) => {
      // Recheck the actual default after remote credential I/O.
      const pushTip = await resolveGitRemoteTip({
        url: revision.remote.url,
        token,
      })
      if (pushTip?.branch !== revision.defaultBranch)
        throw new Error("Default branch changed during credential issuance")
      if (pushTip.sha !== revision.sha && pushTip.sha !== committed.sha)
        throw new WorkspaceTipAdvancedError()
      // Credential acquisition and pack restoration may outlive a relink.
      const live = await getWorkspaceWriteAdmission(input.workspaceId)
      if (!sameWorkspaceRevision(live?.revision, revision))
        throw new Error(
          "Workspace write binding changed during credential issuance",
        )
      if (pushTip.sha === committed.sha) return
      if (live?.writeStatus !== "writable")
        throw new WorkspaceWriteAccessUnavailableError()
      if (input.mirror)
        await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
      await nativeGit(
        directory,
        [
          "push",
          "--porcelain",
          "--",
          revision.remote.url,
          `${committed.sha}:refs/heads/${revision.defaultBranch}`,
        ],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      ).catch((error: unknown) => {
        const reason = writeAccessDenialReason(error)
        if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
        throw error
      })
    },
    committed,
  )
}

function sameWriteBinding(
  current: WorkspaceRevision | null,
  revision: WorkspaceRevision,
): boolean {
  return Boolean(
    current &&
      sameWorkspaceRevision(current, {
        ...revision,
        sha: current.sha,
        access: current.access,
      }),
  )
}

async function remoteContainsCommit(
  revision: WorkspaceRevision,
  committed: GitPack,
  tipSha: string,
  token: string | undefined,
): Promise<boolean> {
  if (tipSha === committed.sha) return true
  if (tipSha === revision.sha) return false
  return withGitDirectory(
    committed.sha,
    async (directory) => {
      await nativeGit(
        directory,
        ["fetch", "--", revision.remote.url, tipSha],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      )
      try {
        await nativeGit(directory, [
          "merge-base",
          "--is-ancestor",
          committed.sha,
          tipSha,
        ])
        return true
      } catch (error) {
        if ((error as { code?: number }).code === 1) return false
        throw error
      }
    },
    committed,
  )
}

export async function publishWorkspaceWriteRevision(
  input: { orgId: string; workspaceId: string; mirror?: ConnectorMirrorSource },
  revision: WorkspaceRevision,
  committed: GitPack,
  env: Env,
): Promise<WorkspaceRevision> {
  // A webhook or another writer may have advanced desired state after our push.
  // Reconcile the actual default and hydrate its canonical tip, retaining our job's commit identity.
  const resolved = await resolveWorkspaceReadRevision({
    ...input,
    env,
    refresh: true,
  })
  if (!resolved || !sameWriteBinding(resolved.revision, revision))
    throw new Error(
      "Workspace write binding changed before hydration publication",
    )
  if (
    !(await remoteContainsCommit(
      revision,
      committed,
      resolved.revision.sha,
      resolved.token,
    ))
  )
    throw new Error(
      "The canonical default no longer contains the prepared write commit",
    )
  return resolved.revision
}

/** Revalidate a no-op against the actual default, outside any SQL transaction. */
export async function refreshWorkspaceWriteRevision(
  input: { orgId: string; workspaceId: string; mirror?: ConnectorMirrorSource },
  revision: WorkspaceRevision,
  env: Env,
): Promise<WorkspaceRevision> {
  const resolved = await resolveWorkspaceReadRevision({
    ...input,
    env,
    refresh: true,
  })
  const live = await getWorkspaceWriteAdmission(input.workspaceId)
  if (!resolved || !sameWriteBinding(resolved.revision, revision))
    throw new Error("Workspace write binding changed during no-op validation")
  if (
    !sameWorkspaceRevision(live?.revision, {
      ...resolved.revision,
      access: "write-default",
    })
  )
    throw new Error("Workspace revision changed during no-op validation")
  if (input.mirror) {
    await assertConnectorMirrorBinding(
      input.orgId,
      input.mirror,
      resolved.revision,
    )
    await assertConnectorMirrorScope(
      input.mirror,
      await readGitPackFromRemote({
        url: resolved.revision.remote.url,
        sha: resolved.revision.sha,
        token: resolved.token,
      }),
    )
  }
  return { ...resolved.revision, access: "write-default" }
}

/** Recoverable native push admission, evaluated inside the caller's durable broker step. */
export async function attemptWorkspaceCommit(
  ...args: Parameters<typeof pushWorkspaceCommit>
): Promise<
  { pushed: true } | { pushed: false; reason: "tip_advanced" | "paused" }
> {
  try {
    await pushWorkspaceCommit(...args)
    return { pushed: true }
  } catch (error) {
    if (error instanceof WorkspaceTipAdvancedError)
      return { pushed: false, reason: "tip_advanced" }
    if (error instanceof WorkspaceWriteAccessUnavailableError) {
      if (error.readOnlyReason) {
        const [input, revision] = args
        await persistWriteStatus(
          {
            id: input.workspaceId,
            desiredGeneration: revision.generation,
            workspaceRepositoryUrl: revision.remote.url,
            githubConnectionId: revision.remote.connectionId,
            desiredDefaultBranch: revision.defaultBranch,
            desiredSha: revision.sha,
          },
          { writeStatus: "read_only", readOnlyReason: error.readOnlyReason },
          input.orgId,
        )
      }
      return { pushed: false, reason: "paused" }
    }
    throw error
  }
}

/** Capture the unpushed native delta and current binding as an immutable child command. */
export async function captureSemanticHandoff(
  input: {
    orgId: string
    workspaceId: string
    jobId: string
    mirror?: ConnectorMirrorSource
  },
  revision: WorkspaceRevision,
  committed: GitPack,
  env: Env,
) {
  const { readGitCommitChanges } = await import(
    "../../services/git/write-tree.js"
  )
  const changes = await readGitCommitChanges(committed, revision.sha)
  const nextRevision = await refreshWorkspaceWriteRevision(input, revision, env)
  const handoff = await persistSemanticHandoff({
    jobId: input.jobId,
    revision,
    nextRevision,
    candidateSha: committed.sha,
    ...changes,
    mirror: input.mirror,
  })
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    handoff,
    revision: nextRevision,
    previousSha: revision.sha,
    ...changes,
    ...(input.mirror ? { mirror: input.mirror } : {}),
  }
}
