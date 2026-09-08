import type { Env } from "../../../config/env.js"
import { assertNotInOrgDbContext } from "../../../db/client.js"
import { resolveRepositoryReadTip } from "../../../domain/workspaces/resolve-revision.js"
import {
  type GithubRepoPermissionBits,
  type GithubRepoWriteView,
  githubInstallationCanPush,
} from "../../../domain/workspaces/write-status.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
export async function resolveGithubBranchTip(input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
  branch: string
  env: Env
}): Promise<string | null> {
  assertNotInOrgDbContext()
  try {
    return (
      (
        await resolveRepositoryReadTip({
          orgId: input.orgId,
          env: input.env,
          remote: {
            url: `https://github.com/${input.repoFullName}`,
            connectionId: input.githubConnectionId ?? null,
          },
          branch: input.branch,
        })
      )?.sha ?? null
    )
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
    return (
      (
        await resolveRepositoryReadTip({
          orgId: input.orgId,
          env: input.env,
          remote: {
            url: `https://github.com/${input.repoFullName}`,
            connectionId: input.githubConnectionId ?? null,
          },
        })
      )?.branch ?? null
    )
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
  const repoCanPush = permissions
    ? githubInstallationCanPush(permissions as GithubRepoPermissionBits)
    : true
  if (repoCanPush) {
    return {
      defaultBranch: data.default_branch || "",
      canPush: true,
    }
  }

  const installationId = ctx.installation?.installationId
  if (typeof installationId === "number") {
    try {
      const { data: installation } =
        await ctx.octokit.rest.apps.getInstallation({
          installation_id: installationId,
        })
      if (
        githubInstallationCanPush(
          installation.permissions as GithubRepoPermissionBits,
        )
      ) {
        return {
          defaultBranch: data.default_branch || "",
          canPush: true,
        }
      }
    } catch {
      /* keep the repos.get deny */
    }
  }

  return {
    defaultBranch: data.default_branch || "",
    canPush: false,
  }
}

export async function resolveWorkspaceRepositoryTip(input: {
  orgId: string
  githubConnectionId?: string | null
  workspaceRepositoryUrl: string
  branch?: string | null
  env: Env
}): Promise<string | null> {
  return (
    (
      await resolveRepositoryReadTip({
        orgId: input.orgId,
        env: input.env,
        remote: {
          url: input.workspaceRepositoryUrl,
          connectionId: input.githubConnectionId ?? null,
        },
        branch: input.branch,
      })
    )?.sha ?? null
  )
}
