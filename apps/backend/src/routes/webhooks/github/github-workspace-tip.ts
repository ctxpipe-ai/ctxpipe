import type { Env } from "../../../config/env.js"
import { applyResolvedTipsForMatchingWorkspaces } from "../../../domain/workspaces/tip-resolve.js"
import { getInstallationOctokitForOrg } from "../../../models/github-installation.js"
import {
  listOrgWorkspaces,
  persistResolvedDesiredSha,
} from "../../../models/workspaces.js"

export async function resolveGithubBranchTip(input: {
  orgId: string
  githubConnectionId?: string | null
  repoFullName: string
  branch: string
  env: Env
}): Promise<string | null> {
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

/** Webhook `after` is a trigger only — never persist it as desired SHA. */
export async function persistWorkspaceTipsOnDefaultBranchPush(input: {
  orgId: string
  repoFullName: string
  defaultBranch: string
  payloadAfter?: string
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
}): Promise<number> {
  void input.payloadAfter
  const workspaces = await listOrgWorkspaces(input.orgId)
  return applyResolvedTipsForMatchingWorkspaces({
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    workspaces,
    resolveTip: input.resolveTip,
    persist: persistResolvedDesiredSha,
  })
}
