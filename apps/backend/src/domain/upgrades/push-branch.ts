import type { Env } from "../../config/env.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import {
  type GitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import type { WorkspaceRevision } from "../workspaces/revision.js"
import {
  gitChangesOutsideWorkspaceRoot,
  workspaceRootPath,
} from "../workspaces/root-path.js"
import { writeAccessDenialReason } from "../workspaces/write-broker.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  WRITE_STATUS_REASONS,
} from "../workspaces/write-status.js"
import { UPGRADE_BRANCH_PREFIX } from "./registry.js"

/** GitHub refused the push of the upgrade branch. The reason is for the operator. */
export class UpgradeWriteAccessError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/**
 * Force-push the upgrade commits to their upgrade branch. Only a branch
 * below {@link UPGRADE_BRANCH_PREFIX} is pushed, never the default branch.
 * The commits must change only files below the Workspace root folder. The
 * write credential stays inside this function.
 */
export async function pushUpgradeBranch(input: {
  orgId: string
  revision: WorkspaceRevision
  committed: GitPack
  branch: string
  env: Env
}): Promise<void> {
  const { revision, committed, branch } = input
  if (
    !branch.startsWith(UPGRADE_BRANCH_PREFIX) ||
    branch === revision.defaultBranch
  )
    throw new Error("An upgrade pushes only its own upgrade branch")
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    throw new UpgradeWriteAccessError(
      "The Workspace repository is not connected with the GitHub App.",
    )
  const token = await getRepoWriteCloneToken(input.orgId, input.env, {
    githubConnectionId: connectionId,
    repoFullName: repositoryName,
  }).catch((error: unknown) => {
    const reason = writeAccessDenialReason(error)
    if (reason) throw new UpgradeWriteAccessError(reason)
    throw error
  })
  if (!token)
    throw new UpgradeWriteAccessError(WRITE_STATUS_REASONS.contentsWriteDenied)
  await withGitDirectory(
    committed.sha,
    async (directory) => {
      const rootPath = workspaceRootPath(revision)
      if (
        rootPath &&
        (
          await gitChangesOutsideWorkspaceRoot({
            directory,
            base: revision.sha,
            head: committed.sha,
            rootPath,
          })
        ).length
      )
        throw new Error(
          "The upgrade changes files outside the Workspace root folder",
        )
      await nativeGit(
        directory,
        [
          "push",
          "--porcelain",
          "--",
          revision.remote.url,
          `+${committed.sha}:refs/heads/${branch}`,
        ],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      ).catch((error: unknown) => {
        const reason = writeAccessDenialReason(error)
        if (reason) throw new UpgradeWriteAccessError(reason)
        throw error
      })
    },
    committed,
    null,
  )
}
