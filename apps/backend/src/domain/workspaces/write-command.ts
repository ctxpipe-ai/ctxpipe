import { isDeepStrictEqual } from "node:util"
import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { getWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
} from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import {
  captureGitPack,
  nativeGit,
  withGitDirectory,
} from "../../services/git/pack.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import type { WorkspaceWriteKind } from "./write-commit-files.js"

export type WorkspaceWriteCommand = {
  orgId: string
  workspaceId: string
  jobId: string
  revision: WorkspaceRevision
  files?: Array<{ path: string; content: string }>
  deletePaths?: string[]
}

/** Org and log scope only; the calling workflow owns all durable execution steps. */
export function withWorkspaceWriteContext<T>(
  input: WorkspaceWriteCommand,
  workflowName: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLogger(
    createLogger({
      workflow: workflowName,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
    }),
    async () => {
      const org = await getSystemDb().query.organizations.findFirst({
        where: { id: { eq: input.orgId } },
      })
      if (!org) throw new Error("Organization not found")
      return withOrgIdContext(org, operation)
    },
  )
}

export async function completedWorkspaceWrite(
  input: WorkspaceWriteCommand,
  kind: WorkspaceWriteKind,
  workflowRunId: string,
) {
  const recorded = await getWorkspaceWriteJob(input.jobId)
  if (!recorded) return null
  if (
    recorded.workspaceId !== input.workspaceId ||
    recorded.kind !== kind ||
    !sameWorkspaceRevision(recorded.payload?.revision, input.revision) ||
    !isDeepStrictEqual(recorded.payload?.mergeFiles, input.files) ||
    !isDeepStrictEqual(recorded.payload?.mergeDeletePaths, input.deletePaths)
  )
    throw new Error("Write job id is already bound to a different command")
  if (recorded.status === "completed")
    return recorded.commitSha
      ? { committed: true as const, commitSha: recorded.commitSha }
      : { committed: false as const, reason: "no_changes" as const }
  if (
    recorded.payload?.workflowRunId &&
    recorded.payload.workflowRunId !== workflowRunId
  )
    throw new Error("Write job is already owned by another workflow run")
  return null
}

/** Capture native immutable data using a read credential; no credential or directory is durable. */
export async function acquireWorkspaceWriteRevision(
  input: WorkspaceWriteCommand,
  revision: WorkspaceRevision,
  env: Env,
) {
  const workspace = await getWorkspaceById(input.workspaceId)
  const current = await getDesiredWorkspaceRevision(
    input.workspaceId,
    "write-default",
  )
  if (!workspace || !sameWorkspaceRevision(current, revision))
    throw new Error("Workspace write binding changed")
  if (workspace.writeStatus !== "writable")
    throw new Error("Workspace is not writable")
  const token = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const pack = await withGitDirectory(revision.sha, async (directory) => {
    await nativeGit(
      directory,
      ["fetch", "--depth", "1", "--", revision.remote.url, revision.sha],
      undefined,
      gitRemoteEnvironment({ url: revision.remote.url, token }),
    )
    return captureGitPack(directory, revision.sha)
  })
  return { pack, displayName: workspace.displayName }
}
