import type { Env } from "../../config/env.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { readUnbornRemoteBranch } from "../../services/git/unborn-tree.js"
import {
  type UnbornBootstrapBinding,
  unbornBootstrapBindingSchema,
} from "./bootstrap-input.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"

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
  })
  await getUnbornBootstrapWorkspace(binding)
  return binding
}
