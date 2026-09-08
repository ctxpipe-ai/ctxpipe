import type { Env } from "../../config/env.js"
import { assertNotInOrgDbContext } from "../../db/client.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import {
  captureWorkspaceRevision,
  getWorkspaceById,
  persistRevisionResolutionFailure,
} from "../../models/workspaces.js"
import { resolveGitRemoteTip } from "../../services/git/clone-tree.js"
import type { WorkspaceRevision } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** Scope a transient read credential to the remote's explicit connection. */
export async function resolveRepositoryReadCredential(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
}): Promise<string | undefined> {
  assertNotInOrgDbContext()
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(input.remote.url)
  if (!repositoryName || !input.remote.githubConnectionId) return undefined
  const token = await getRepoReadCloneToken(input.orgId, input.env, {
    repoFullName: repositoryName,
    githubConnectionId: input.remote.githubConnectionId,
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
  expected?:
    | WorkspaceRevision
    | { generation?: number; url?: string; sha?: string }
}) {
  assertNotInOrgDbContext()
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) return null
  if (workspace.orgId !== input.orgId) throw new Error("Workspace not found")
  const bound =
    input.expected && "remote" in input.expected ? input.expected : null
  const expected = bound
    ? { generation: bound.generation, url: bound.remote.url, sha: bound.sha }
    : (input.expected as
        | { generation?: number; url?: string; sha?: string }
        | undefined)
  if (
    bound &&
    (bound.workspaceId !== workspace.id ||
      bound.access !== "read" ||
      bound.remote.githubConnectionId !== workspace.githubConnectionId ||
      bound.defaultBranch !== workspace.desiredDefaultBranch)
  )
    return null
  if (
    (expected?.generation !== undefined &&
      expected.generation !== workspace.desiredGeneration) ||
    (expected?.url !== undefined &&
      expected.url !== workspace.workspaceRepositoryUrl) ||
    (expected?.sha !== undefined && expected.sha !== workspace.desiredSha)
  )
    return null
  try {
    if (!workspace.desiredSha && !input.refresh)
      throw new Error(
        "Could not resolve the git tip for this workspace repository.",
      )
    const needsTip = input.refresh || !workspace.desiredDefaultBranch
    const token = needsTip
      ? await resolveRepositoryReadCredential({
          orgId: input.orgId,
          env: input.env,
          remote: {
            url: workspace.workspaceRepositoryUrl,
            githubConnectionId: workspace.githubConnectionId,
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
      sha: input.refresh ? resolved?.sha : workspace.desiredSha,
      branch: resolved?.branch ?? workspace.desiredDefaultBranch,
    }
    if (!tip.sha || !tip.branch)
      throw new Error("The workspace repository has no default branch")
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
    })
    throw error
  }
}
