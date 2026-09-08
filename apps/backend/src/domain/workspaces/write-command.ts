import { isDeepStrictEqual } from "node:util"
import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import type { ConnectorMirrorSource } from "./connector-mirror.js"
import {
  assertConnectorMirrorBinding,
  assertConnectorMirrorScope,
} from "./connector-mirror.js"
import type { WorkspaceExtraction } from "./extraction.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import type { WorkspaceWriteKind } from "./write-jobs.js"

export type WorkspaceWriteCommand = {
  orgId: string
  workspaceId: string
  jobId: string
  revision: WorkspaceRevision
  files?: GitFileChange[]
  deletePaths?: string[]
  linkAction?: "link" | "unlink"
  linkGitUrl?: string
  displayName?: string
  previousSha?: string
  extraction?: WorkspaceExtraction
  mirror?: ConnectorMirrorSource
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
  const recorded = await reconcileWorkspaceWriteJob(input.jobId)
  if (!recorded) return null
  if (
    recorded.workspaceId !== input.workspaceId ||
    recorded.kind !== kind ||
    !sameWorkspaceRevision(recorded.payload?.revision, input.revision) ||
    !isDeepStrictEqual(recorded.payload?.mergeFiles, input.files) ||
    !isDeepStrictEqual(recorded.payload?.mergeDeletePaths, input.deletePaths) ||
    recorded.payload?.linkAction !== input.linkAction ||
    recorded.payload?.linkGitUrl !== input.linkGitUrl ||
    !isDeepStrictEqual(recorded.payload?.mirror, input.mirror) ||
    !isDeepStrictEqual(recorded.payload?.extraction, input.extraction) ||
    recorded.payload?.previousSha !== input.previousSha ||
    recorded.payload?.displayName !== input.displayName
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
  previousSha?: string,
) {
  if (input.mirror)
    await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
  const workspace = await getWorkspaceWriteAdmission(input.workspaceId)
  const current = workspace?.revision
  if (
    !workspace ||
    !current ||
    !sameWorkspaceRevision(current, { ...revision, sha: current.sha })
  )
    throw new Error("Workspace write binding changed")
  if (workspace.writeStatus !== "writable") return null
  const token = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const pack = await readGitPackFromRemote({
    url: revision.remote.url,
    sha: revision.sha,
    additionalShas: previousSha ? [previousSha] : [],
    token,
  })
  if (input.mirror) await assertConnectorMirrorScope(input.mirror, pack)
  return { pack, displayName: workspace.displayName }
}
