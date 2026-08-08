import type { Env } from "../../config/env.js"
import type {
  LinearConnection,
  LinearScope,
  LinearSyncTargetWithRepo,
} from "../../models/linear-connector.js"
import {
  closePullRequest,
  createPullRequestWithFiles,
  getFileContent,
  parseGithubPullNumberFromUrl,
} from "../github/installation-write-client.js"
import { LINEAR_CONFIG_PATH } from "./config-from-repo.js"
import {
  getLinearConfigPullRequestPayload,
  hasLinearConfigYamlChanged,
  renderLinearConfigYaml,
} from "./config-yaml.js"

export async function syncLinearConfigYaml(input: {
  orgId: string
  orgSlug: string
  env: Env
  connection: LinearConnection
  target: LinearSyncTargetWithRepo
  scopes: LinearScope[]
}): Promise<{ changed: boolean; pullUrl?: string }> {
  const githubConnectionId = input.target.githubConnectionId
  if (!githubConnectionId) {
    throw new Error("Linear sync repository has no GitHub connection")
  }
  const next = renderLinearConfigYaml({
    workspaceId: input.connection.workspaceId,
    workspaceName: input.connection.workspaceName,
    scopes: input.scopes,
  })
  const current = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.target.repositoryName,
    githubConnectionId,
    branch: input.target.branch,
    path: LINEAR_CONFIG_PATH,
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
  return { changed: true, pullUrl: pullRequest.pullUrl }
}
