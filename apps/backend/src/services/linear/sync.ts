import type { Env } from "../../config/env.js"
import type {
  LinearBindingWithRepo,
  LinearConnection,
  LinearScope,
} from "../../models/linear-connector.js"
import {
  linearAccessToken,
  linearWorkspaceIdentity,
} from "../../models/linear-oauth-app.js"
import { connectorPathMatchesPreservation } from "../connectors/assets.js"
import {
  closePullRequest,
  createPullRequestWithFiles,
  getFileContent,
  getPullRequestHeadBranch,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import {
  downloadLinearMirrorAssets,
  omitUnchangedLinearFiles,
} from "./assets.js"
import { type LinearTokenRefreshHandler, withLinearClient } from "./client.js"
import { LINEAR_CONFIG_PATH } from "./config-from-repo.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  getLinearConfigPullRequestPayload,
  hasLinearConfigYamlChanged,
  parseLinearConfigYamlContent,
  renderLinearConfigYaml,
} from "./config-yaml.js"
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
  const workspace = linearWorkspaceIdentity(input.connection)
  const next = renderLinearConfigYaml({
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.workspaceName,
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

function existingPathsFromCapture(input: {
  existingPaths: string[]
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
}): string[] {
  return input.existingBlobs
    ? input.existingBlobs.map((file) => file.path)
    : input.existingPaths
}

/**
 * Download assets for the collected mirror pages and diff them against the
 * captured workspace tree. The calling workflow owns the native Git child.
 */
export async function captureLinearContent(input: {
  env: Env
  connection: LinearConnection
  files: Array<{ path: string; content: string; encoding?: "utf-8" | "base64" }>
  failures: Array<{ type: string; id: string; message: string }>
  existingPaths: string[]
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
  onTokenRefresh?: LinearTokenRefreshHandler
}) {
  if (input.files.length === 0 && input.failures.length > 0) {
    return {
      status: "failed" as const,
      files: [],
      deletePaths: [],
      failures: input.failures,
    }
  }
  await withLinearClient(
    {
      env: input.env,
      connection: input.connection,
      onTokenRefresh: input.onTokenRefresh,
    },
    async () => undefined,
  )
  const existingPaths = existingPathsFromCapture(input)
  const downloaded = await downloadLinearMirrorAssets({
    files: input.files,
    accessToken: linearAccessToken(input.connection),
    existingShaByPath: input.existingBlobs
      ? new Map(input.existingBlobs.map((file) => [file.path, file.sha]))
      : undefined,
  })
  const nextPaths = new Set(downloaded.files.map((file) => file.path))
  const deletePaths =
    input.failures.length === 0
      ? existingPaths.filter(
          (path) =>
            path.startsWith("linear/") &&
            path !== LINEAR_CONFIG_PATH &&
            !nextPaths.has(path) &&
            !downloaded.preservePathPrefixes.some((prefix) =>
              connectorPathMatchesPreservation(path, prefix),
            ),
        )
      : []
  const files = input.existingBlobs
    ? omitUnchangedLinearFiles(downloaded.files, input.existingBlobs)
    : downloaded.files
  return {
    status:
      input.failures.length > 0
        ? ("partial_failed" as const)
        : ("completed" as const),
    files,
    deletePaths,
    failures: input.failures,
  }
}

export async function captureLinearIncrementalContent(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  existingPaths: string[]
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
  entity: LinearEntityChange
  onTokenRefresh?: LinearTokenRefreshHandler
}) {
  const existingPaths = existingPathsFromCapture(input)
  const changes = await buildLinearIncrementalChanges({
    env: input.env,
    connection: input.connection,
    config: input.config,
    entities: [input.entity],
    existingPaths,
    existingShaByPath: input.existingBlobs
      ? new Map(input.existingBlobs.map((file) => [file.path, file.sha]))
      : undefined,
    onTokenRefresh: input.onTokenRefresh,
  })
  const files = input.existingBlobs
    ? omitUnchangedLinearFiles(changes.files, input.existingBlobs)
    : changes.files
  return {
    files,
    deletePaths: changes.deletePaths,
    failures: changes.failures,
  }
}
