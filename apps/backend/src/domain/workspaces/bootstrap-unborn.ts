import { type Env, parseEnv } from "../../config/env.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { listGitPathsAtSha } from "../../services/git/clone-tree.js"
import { readUnbornRemoteBranch } from "../../services/git/unborn-tree.js"
import {
  type UnbornBootstrapBinding,
  unbornBootstrapBindingSchema,
} from "./bootstrap-input.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import type { WorkspaceRevision } from "./revision.js"
import { workspaceRootPath } from "./root-path.js"
import {
  CTXPIPE_CONTENT_FOLDERS,
  hasCtxpipeContent,
} from "./workspace-format.js"

export async function getUnbornBootstrapWorkspace(
  binding: UnbornBootstrapBinding,
) {
  const workspace = await getWorkspaceById(binding.workspaceId)
  if (
    !workspace ||
    workspace.desiredGeneration !== binding.generation ||
    workspace.workspaceRepositoryUrl !== binding.remote.url ||
    workspace.githubConnectionId !== binding.remote.connectionId ||
    (workspace.desiredDefaultBranch !== null &&
      workspace.desiredDefaultBranch !== binding.defaultBranch)
  )
    throw new Error("Bootstrap repository binding changed")
  return workspace
}

export async function captureUnbornBootstrapBinding(input: {
  orgId: string
  workspaceId: string
  env: Env
}): Promise<UnbornBootstrapBinding | null> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace || workspace.desiredSha) return null
  const remote = {
    url: workspace.workspaceRepositoryUrl,
    connectionId: workspace.githubConnectionId,
  }
  const token = await resolveRepositoryReadCredential({ ...input, remote })
  const branch = await readUnbornRemoteBranch({ url: remote.url, token })
  if (!branch) return null
  const binding = unbornBootstrapBindingSchema.parse({
    workspaceId: workspace.id,
    generation: workspace.desiredGeneration,
    remote,
    defaultBranch: branch,
    ...(workspaceRootPath(workspace)
      ? { rootPath: workspaceRootPath(workspace) }
      : {}),
  })
  await getUnbornBootstrapWorkspace(binding)
  return binding
}

/**
 * True when the tree of `revision` has ctx| content (see
 * {@link hasCtxpipeContent}). The fetch gets only the trees.
 */
export async function revisionHasCtxpipeContent(
  orgId: string,
  revision: WorkspaceRevision,
): Promise<boolean> {
  return hasCtxpipeContent(
    await listGitPathsAtSha({
      url: revision.remote.url,
      sha: revision.sha,
      token: await resolveRepositoryReadCredential({
        orgId,
        env: parseEnv(process.env),
        remote: revision.remote,
      }),
      root: workspaceRootPath(revision),
      folders: CTXPIPE_CONTENT_FOLDERS,
    }),
  )
}
