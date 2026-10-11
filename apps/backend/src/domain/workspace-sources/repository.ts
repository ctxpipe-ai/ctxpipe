import { type Env, parseEnv } from "../../config/env.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"

/**
 * The GitHub repository and default branch of a Workspace, as the GitHub
 * write client needs them. Null when the Workspace has no connected GitHub
 * repository.
 */
export function workspaceGithubRepository(
  workspace: {
    orgId: string
    workspaceRepositoryUrl: string
    githubConnectionId: string | null
    desiredDefaultBranch?: string | null
  },
  env: Env = parseEnv(process.env),
) {
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    workspace.workspaceRepositoryUrl,
  )
  if (!repositoryName || !workspace.githubConnectionId) return null
  return {
    orgId: workspace.orgId,
    env,
    repositoryName,
    githubConnectionId: workspace.githubConnectionId,
    branch: workspace.desiredDefaultBranch ?? "main",
  }
}
