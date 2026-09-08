import type { Env } from "../../config/env.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
} from "../../models/workspaces.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import {
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  assertConnectorMirrorBinding,
  type ConnectorMirrorSource,
} from "./connector-mirror.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

class WorkspaceTipAdvancedError extends Error {
  constructor() {
    super("Default branch advanced; semantic merge is required")
  }
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
  const current = await getDesiredWorkspaceRevision(
    input.workspaceId,
    "write-default",
  )
  const workspace = await getWorkspaceById(input.workspaceId)
  if (
    !workspace ||
    !sameWriteBinding(current, revision) ||
    workspace.writeStatus !== "writable"
  )
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
  if (tip.sha !== revision.sha || !sameWorkspaceRevision(current, revision))
    throw new WorkspaceTipAdvancedError()
  if (input.mirror)
    await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
  const token = await getRepoWriteCloneToken(input.orgId, env, {
    githubConnectionId: connectionId,
    repoFullName: repositoryName,
  })
  if (!token) throw new Error("No repository write credential")
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
      const admitted = await getDesiredWorkspaceRevision(
        input.workspaceId,
        "write-default",
      )
      const live = await getWorkspaceById(input.workspaceId)
      if (
        !sameWorkspaceRevision(admitted, revision) ||
        live?.writeStatus !== "writable"
      )
        throw new Error(
          "Workspace write binding changed during credential issuance",
        )
      if (pushTip.sha === committed.sha) return
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
      )
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
  const live = await getWorkspaceById(input.workspaceId)
  if (
    !resolved ||
    !sameWriteBinding(resolved.revision, revision) ||
    live?.writeStatus !== "writable"
  )
    throw new Error("Workspace write binding changed during no-op validation")
  const current = await getDesiredWorkspaceRevision(input.workspaceId)
  if (!sameWorkspaceRevision(current, resolved.revision))
    throw new Error("Workspace revision changed during no-op validation")
  return { ...resolved.revision, access: "write-default" }
}

/** Recoverable native push admission, evaluated inside the caller's durable broker step. */
export async function attemptWorkspaceCommit(
  ...args: Parameters<typeof pushWorkspaceCommit>
): Promise<{ pushed: boolean }> {
  try {
    await pushWorkspaceCommit(...args)
    return { pushed: true }
  } catch (error) {
    if (error instanceof WorkspaceTipAdvancedError) return { pushed: false }
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
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    jobId: `${input.jobId}:semantic`,
    revision: await refreshWorkspaceWriteRevision(input, revision, env),
    previousSha: revision.sha,
    ...changes,
    ...(input.mirror ? { mirror: input.mirror } : {}),
  }
}
