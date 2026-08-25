import type { Env } from "../../../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../../db/client.js"
import {
  applyResolvedTipsForMatchingLinked,
  applyResolvedTipsForMatchingWorkspaces,
} from "../../../domain/workspaces/tip-resolve.js"
import {
  type GithubRepoPermissionBits,
  type GithubRepoWriteView,
  githubInstallationCanPush,
  githubRepoFullNameFromWorkspaceUrl,
} from "../../../domain/workspaces/write-status.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import {
  listOrgLinkedRepositories,
  listOrgWorkspaces,
  persistLinkedDesiredSha,
  persistResolvedDesiredSha,
} from "../../../models/workspaces.js"

export async function resolveGithubBranchTip(input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
  branch: string
  env: Env
}): Promise<string | null> {
  assertNotInOrgDbContext()
  try {
    const ctx = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.githubConnectionId ?? undefined,
    )
    if (!ctx) return null
    const [owner, repo] = input.repoFullName.split("/")
    if (!owner || !repo) return null
    const { data } = await ctx.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${input.branch}`,
    })
    return typeof data.object.sha === "string" ? data.object.sha : null
  } catch {
    return null
  }
}

export async function resolveGithubDefaultBranch(input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
  env: Env
}): Promise<string | null> {
  assertNotInOrgDbContext()
  try {
    const ctx = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.githubConnectionId ?? undefined,
    )
    if (!ctx) return null
    const [owner, repo] = input.repoFullName.split("/")
    if (!owner || !repo) return null
    const { data } = await ctx.octokit.rest.repos.get({ owner, repo })
    return data.default_branch || null
  } catch {
    return null
  }
}

export async function getGithubRepoWriteView(input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
  env: Env
}): Promise<GithubRepoWriteView> {
  assertNotInOrgDbContext()
  const ctx = await getInstallationOctokitForOrg(
    input.orgId,
    input.env,
    input.githubConnectionId ?? undefined,
  )
  if (!ctx) {
    throw new Error("GitHub installation not found")
  }
  const [owner, repo] = input.repoFullName.split("/")
  if (!owner || !repo) {
    const error = new Error("Invalid repository name") as Error & {
      status: number
    }
    error.status = 404
    throw error
  }
  const { data } = await ctx.octokit.rest.repos.get({ owner, repo })
  const permissions = data.permissions
  return {
    defaultBranch: data.default_branch || "",
    canPush: permissions
      ? githubInstallationCanPush(permissions as GithubRepoPermissionBits)
      : true,
  }
}

export async function resolveWorkspaceRepositoryTip(input: {
  orgId: string
  githubConnectionId?: string | null
  workspaceRepositoryUrl: string
  branch?: string | null
  env: Env
}): Promise<string | null> {
  const fullName = githubRepoFullNameFromWorkspaceUrl(
    input.workspaceRepositoryUrl,
  )
  if (!fullName) return null
  try {
    const requested = input.branch?.trim()
    if (requested) {
      return resolveGithubBranchTip({
        orgId: input.orgId,
        githubConnectionId: input.githubConnectionId,
        repoFullName: fullName,
        branch: requested,
        env: input.env,
      })
    }
    const ctx = await getInstallationOctokitForOrg(
      input.orgId,
      input.env,
      input.githubConnectionId ?? undefined,
    )
    if (!ctx) return null
    const [owner, repo] = fullName.split("/")
    if (!owner || !repo) return null
    const { data: repoMeta } = await ctx.octokit.rest.repos.get({
      owner,
      repo,
    })
    const branch = repoMeta.default_branch
    if (!branch) return null
    return resolveGithubBranchTip({
      orgId: input.orgId,
      githubConnectionId: input.githubConnectionId,
      repoFullName: fullName,
      branch,
      env: input.env,
    })
  } catch {
    return null
  }
}

/** Webhook `after` is a trigger only — never persist it as desired SHA. */
export async function persistWorkspaceTipsOnDefaultBranchPush(input: {
  orgId: string
  repoFullName: string
  defaultBranch: string
  payloadAfter?: string
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
}): Promise<number> {
  void input.payloadAfter
  const workspaces = await withOrgDbContext(input.orgId, () =>
    listOrgWorkspaces(input.orgId),
  )
  assertNotInOrgDbContext()
  return applyResolvedTipsForMatchingWorkspaces({
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    workspaces,
    resolveTip: input.resolveTip,
    persist: (row) =>
      withOrgDbContext(input.orgId, () => persistResolvedDesiredSha(row)),
  })
}

export async function persistLinkedTipsOnRefPush(input: {
  orgId: string
  repoFullName: string
  webhookRef: string
  defaultBranch: string
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
}): Promise<Array<{ linkedId: string; resolvedTip: string }>> {
  const linked = await withOrgDbContext(input.orgId, () =>
    listOrgLinkedRepositories(input.orgId),
  )
  assertNotInOrgDbContext()
  return applyResolvedTipsForMatchingLinked({
    repoFullName: input.repoFullName,
    webhookRef: input.webhookRef,
    defaultBranch: input.defaultBranch,
    linked,
    resolveTip: input.resolveTip,
    persist: (row) =>
      withOrgDbContext(input.orgId, () => persistLinkedDesiredSha(row)),
  })
}
