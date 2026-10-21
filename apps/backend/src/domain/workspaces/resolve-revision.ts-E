import { RequestError } from "octokit"
import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import {
  captureWorkspaceRevision,
  getLinkedReadBinding,
  getWorkspaceById,
  persistLinkedDesiredSha,
  persistRevisionResolutionFailure,
} from "../../models/workspaces.js"
import {
  GitRemoteAccessError,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import type { GitRemoteRead } from "../../services/git/pack.js"
import { readUnbornRemoteBranch } from "../../services/git/unborn-tree.js"
import { linkedRevisionSchema, type WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * Transient read access to the bound repository of a Workspace, for a Git
 * operation on a stored pack with a base (CTX-955). The caller takes the org
 * and the remote from the workflow input or from the database binding, never
 * from a step output.
 */
export function workspaceGitRead(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
}): GitRemoteRead {
  return {
    url: input.remote.url,
    token: () => resolveRepositoryReadCredential(input),
  }
}

/** Scope a transient read credential to the remote's explicit connection. */
export async function resolveRepositoryReadCredential(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
}): Promise<string | undefined> {
  assertNotInOrgDbContext()
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(input.remote.url)
  if (!repositoryName || !input.remote.connectionId) return undefined
  const token = await getRepoReadCloneToken(input.orgId, input.env, {
    repoFullName: repositoryName,
    githubConnectionId: input.remote.connectionId,
  }).catch((error: unknown) => {
    // GitHub refuses the token when the installation has no repository of
    // that name (422), for example after a delete, or cannot see it (404).
    if (
      error instanceof RequestError &&
      (error.status === 422 || error.status === 404)
    )
      throw new GitRemoteAccessError({ hasCredential: true, stderr: "" })
    throw error
  })
  if (!token) throw new Error("The connected repository has no read credential")
  return token
}

export async function resolveRepositoryReadTip(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
  branch?: string | null
}) {
  const token = await resolveRepositoryReadCredential(input)
  return resolveGitRemoteTip({
    url: input.remote.url,
    branch: input.branch,
    token,
  })
}

/** Resolve product identity once; tokens stay outside the serializable revision. */
export async function resolveWorkspaceReadRevision(input: {
  orgId: string
  workspaceId: string
  env: Env
  refresh?: boolean
  expected?: WorkspaceRevision
}) {
  assertNotInOrgDbContext()
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) return null
  if (workspace.orgId !== input.orgId) throw new Error("Workspace not found")
  const expected = input.expected
  if (
    expected &&
    (expected.workspaceId !== workspace.id ||
      expected.access !== "read" ||
      expected.generation !== workspace.desiredGeneration ||
      expected.remote.url !== workspace.workspaceRepositoryUrl ||
      expected.remote.connectionId !== workspace.githubConnectionId ||
      expected.defaultBranch !== workspace.desiredDefaultBranch ||
      expected.sha !== workspace.desiredSha)
  )
    return null
  try {
    const refresh = input.refresh || !workspace.desiredSha
    const needsTip = refresh || !workspace.desiredDefaultBranch
    const token = needsTip
      ? await resolveRepositoryReadCredential({
          orgId: input.orgId,
          env: input.env,
          remote: {
            url: workspace.workspaceRepositoryUrl,
            connectionId: workspace.githubConnectionId,
          },
        })
      : undefined
    const resolved = needsTip
      ? await resolveGitRemoteTip({
          url: workspace.workspaceRepositoryUrl,
          token,
        })
      : null
    const tip = {
      sha: refresh ? resolved?.sha : workspace.desiredSha,
      branch: resolved?.branch ?? workspace.desiredDefaultBranch,
    }
    if (!tip.sha || !tip.branch) {
      if (
        !workspace.desiredSha &&
        !resolved &&
        (await readUnbornRemoteBranch({
          url: workspace.workspaceRepositoryUrl,
          token,
        }))
      )
        return null
      throw new Error("The workspace repository has no default branch")
    }
    const revision = await captureWorkspaceRevision({
      workspaceId: workspace.id,
      expected: {
        generation: workspace.desiredGeneration,
        url: workspace.workspaceRepositoryUrl,
        sha: workspace.desiredSha,
        githubConnectionId: workspace.githubConnectionId,
        defaultBranch: workspace.desiredDefaultBranch ?? null,
      },
      tip: { sha: tip.sha, branch: tip.branch },
    })
    return revision ? { revision, token, workspace } : null
  } catch (error) {
    await persistRevisionResolutionFailure({
      expected: workspace,
      message: error instanceof Error ? error.message : String(error),
      noAccess: error instanceof GitRemoteAccessError,
    })
    throw error
  }
}

/** Linked reads use the same transient credential policy and fence their captured binding. */
export async function resolveLinkedReadRevision(input: {
  orgId: string
  linkId: string
  env: Env
}) {
  assertNotInOrgDbContext()
  const binding = await getLinkedReadBinding(input.linkId)
  if (!binding) return null
  const tip = await resolveRepositoryReadTip({
    orgId: input.orgId,
    env: input.env,
    remote: binding.remote,
    branch: binding.ref,
  })
  if (!tip) return null
  const revision = linkedRevisionSchema.parse({ ...binding, sha: tip.sha })
  if (!(await persistLinkedDesiredSha({ binding, resolvedTip: tip.sha })))
    return null
  return { revision, changed: binding.sha !== revision.sha }
}
