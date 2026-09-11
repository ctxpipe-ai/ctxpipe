import type { Env } from "../../config/env.js"
import type {
  LinearBindingWithRepo,
  LinearConnection,
  LinearScope,
} from "../../models/linear-connector.js"
import {
  closePullRequest,
  createPullRequestWithFiles,
  getFileContent,
  getPullRequestHeadBranch,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import type { LinearTokenRefreshHandler } from "./client.js"
import { LINEAR_CONFIG_PATH } from "./config-from-repo.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  getLinearConfigPullRequestPayload,
  hasLinearConfigYamlChanged,
  parseLinearConfigYamlContent,
  renderLinearConfigYaml,
} from "./config-yaml.js"
import { buildLinearMirror } from "./content.js"
import {
  buildLinearIncrementalChanges,
  type LinearEntityChange,
} from "./incremental.js"

export async function syncLinearConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connection: LinearConnection
  target: LinearBindingWithRepo
  scopes: LinearScope[]
}): Promise<{ changed: boolean; pullUrl?: string; pullNumber?: number }> {
  const githubConnectionId = input.target.githubConnectionId
  if (!githubConnectionId) {
    throw new Error("Linear sync repository has no GitHub connection")
  }
  let current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    branch: input.target.branch,
    path: LINEAR_CONFIG_PATH,
  })
  if (input.target.pendingConfigPullUrl) {
    const pendingBranch = await getPullRequestHeadBranch({
      orgId: input.orgId,
      env: input.env,
      repositoryName: input.target.repositoryName,
      githubConnectionId,
      pullUrl: input.target.pendingConfigPullUrl,
    })
    if (pendingBranch) {
      current =
        (await getFileContent({
          orgId: input.orgId,
          env: input.env,
          repositoryName: input.target.repositoryName,
          githubConnectionId,
          branch: pendingBranch,
          path: LINEAR_CONFIG_PATH,
        })) ?? current
    }
  }
  const next = renderLinearConfigYaml({
    workspaceId: input.connection.workspaceId,
    workspaceName: input.connection.workspaceName,
    scopes: input.scopes,
    customerRequests:
      parseLinearConfigYamlContent(current)?.customerRequests ?? "limited",
  })
  if (!hasLinearConfigYamlChanged({ current, next })) {
    return { changed: false }
  }

  const pendingUrl = input.target.pendingConfigPullUrl
  const pendingPullNumber = pendingUrl
    ? parseGithubPullNumberFromUrl(pendingUrl)
    : undefined
  if (pendingPullNumber !== undefined) {
    await closePullRequest({
      orgId: input.orgId,
      env: input.env,
      repositoryName: input.target.repositoryName,
      githubConnectionId,
      pullNumber: pendingPullNumber,
      comment: "Superseded by a newer Linear connector configuration.",
    })
  }

  const pullRequest = await createPullRequestWithFiles({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    baseBranch: input.target.branch,
    featureBranchPrefix: "ctxpipe/linear-config",
    ...getLinearConfigPullRequestPayload({ orgSlug: input.orgSlug }),
    files: [{ path: LINEAR_CONFIG_PATH, content: next }],
  })
  return {
    changed: true,
    pullUrl: pullRequest.pullUrl,
    pullNumber: pullRequest.pullNumber,
  }
}

/** Fetch provider content; the calling workflow owns the native Git child. */
export async function captureLinearContent(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  existingPaths: string[]
  onTokenRefresh?: LinearTokenRefreshHandler
}) {
  if (input.config.workspaceId !== input.connection.workspaceId)
    throw new Error(
      "linear/config.yaml workspace does not match the Linear connection",
    )
  const mirror = await buildLinearMirror(input)
  const failed = mirror.files.length === 0 && mirror.failures.length > 0
  const nextPaths = new Set(mirror.files.map((file) => file.path))
  const deletePaths =
    mirror.failures.length === 0
      ? input.existingPaths.filter(
          (path) =>
            path.startsWith("linear/") &&
            path !== LINEAR_CONFIG_PATH &&
            !nextPaths.has(path),
        )
      : []
  return {
    status: failed
      ? ("failed" as const)
      : mirror.failures.length
        ? ("partial_failed" as const)
        : ("completed" as const),
    files: mirror.files,
    deletePaths,
    failures: mirror.failures,
  }
}

export async function captureLinearIncrementalContent(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  existingPaths: string[]
  entity: LinearEntityChange
  onTokenRefresh?: LinearTokenRefreshHandler
}) {
  return buildLinearIncrementalChanges({ ...input, entities: [input.entity] })
}
