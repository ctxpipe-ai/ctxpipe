import { type Env, parseEnv } from "../../config/env.js"
import { workspaceRootPath } from "../workspaces/root-path.js"
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
    rootPath?: string
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
    // File reads and pull requests stay below the Workspace root folder.
    rootPath: workspaceRootPath(workspace),
  }
}
