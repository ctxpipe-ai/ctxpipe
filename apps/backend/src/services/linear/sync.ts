import type { Env } from "../../config/env.js"
import {
  type LinearConnection,
  type LinearScope,
  type LinearSyncTargetWithRepo,
  withLinearSyncTargetSnapshot,
} from "../../models/linear-connector.js"
import {
  closePullRequest,
  commitFiles,
  createPullRequestWithFiles,
  getFileContent,
  listFilesInTree,
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
  target: LinearSyncTargetWithRepo
  scopes: LinearScope[]
}): Promise<{ changed: boolean; pullUrl?: string; pullNumber?: number }> {
  const githubConnectionId = input.target.githubConnectionId
  if (!githubConnectionId) {
    throw new Error("Linear sync repository has no GitHub connection")
  }
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    branch: input.target.branch,
    path: LINEAR_CONFIG_PATH,
  })
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

export async function syncLinearContentToGit(input: {
  orgId: string
  env: Env
  connection: LinearConnection
  target: LinearSyncTargetWithRepo
  config: ParsedLinearRepoConfig
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<{
  status: "completed" | "partial_failed" | "failed"
  written: number
  deleted: number
  failures: Array<{ type: string; id: string; message: string }>
}> {
  const githubConnectionId = input.target.githubConnectionId
  if (!githubConnectionId) {
    throw new Error("Linear sync repository has no GitHub connection")
  }
  if (input.config.workspaceId !== input.connection.workspaceId) {
    throw new Error(
      "linear/config.yaml workspace does not match the Linear connection",
    )
  }
  const mirror = await buildLinearMirror({
    env: input.env,
    connection: input.connection,
    config: input.config,
    onTokenRefresh: input.onTokenRefresh,
  })
  if (mirror.files.length === 0 && mirror.failures.length > 0) {
    return {
      status: "failed",
      written: 0,
      deleted: 0,
      failures: mirror.failures,
    }
  }

  const existing = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    branch: input.target.branch,
  })
  const nextPaths = new Set(mirror.files.map((file) => file.path))
  const deletePaths =
    mirror.failures.length === 0
      ? existing
          .map((file) => file.path)
          .filter(
            (path) =>
              path.startsWith("linear/") &&
              path !== LINEAR_CONFIG_PATH &&
              !nextPaths.has(path),
          )
      : []

  await withLinearSyncTargetSnapshot(
    {
      connectionId: input.connection.id,
      repositoryId: input.target.repositoryId,
      branch: input.target.branch,
      setupPhase: "initial_sync",
    },
    async () => {
      if (mirror.files.length > 0 || deletePaths.length > 0) {
        await commitFiles({
          orgId: input.orgId,
          env: input.env,
          repositoryName: input.target.repositoryName,
          githubConnectionId,
          branch: input.target.branch,
          message: "chore(linear): sync workspace content",
          files: mirror.files,
          deletePaths,
        })
      }
    },
  )
  return {
    status: mirror.failures.length > 0 ? "partial_failed" : "completed",
    written: mirror.files.length,
    deleted: deletePaths.length,
    failures: mirror.failures,
  }
}

export async function syncLinearIncrementalContent(input: {
  orgId: string
  env: Env
  connection: LinearConnection
  target: LinearSyncTargetWithRepo
  config: ParsedLinearRepoConfig
  entity: LinearEntityChange
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<{
  written: number
  deleted: number
  failures: Array<{ type: string; id: string; message: string }>
}> {
  const githubConnectionId = input.target.githubConnectionId
  if (!githubConnectionId) {
    throw new Error("Linear sync repository has no GitHub connection")
  }
  const existing = await listFilesInTree({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    branch: input.target.branch,
  })
  const changes = await buildLinearIncrementalChanges({
    env: input.env,
    connection: input.connection,
    config: input.config,
    entities: [input.entity],
    existingPaths: existing.map((file) => file.path),
    onTokenRefresh: input.onTokenRefresh,
  })
  await withLinearSyncTargetSnapshot(
    {
      connectionId: input.connection.id,
      repositoryId: input.target.repositoryId,
      branch: input.target.branch,
      setupPhase: "live",
    },
    async () => {
      if (changes.files.length > 0 || changes.deletePaths.length > 0) {
        await commitFiles({
          orgId: input.orgId,
          env: input.env,
          repositoryName: input.target.repositoryName,
          githubConnectionId,
          branch: input.target.branch,
          message: "chore(linear): apply incremental updates",
          files: changes.files,
          deletePaths: changes.deletePaths,
        })
      }
    },
  )
  return {
    written: changes.files.length,
    deleted: changes.deletePaths.length,
    failures: changes.failures,
  }
}
