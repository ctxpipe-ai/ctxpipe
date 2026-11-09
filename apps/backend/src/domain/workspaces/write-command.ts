import { isDeepStrictEqual } from "node:util"

import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  discardWriteJobPreparedCommit,
  persistWriteJobCommitSha,
  persistWriteJobPreparedCommit,
  reconcileWorkspaceWriteJob,
  validateSemanticHandoff,
} from "../../models/workspace-write-jobs.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { prepareGitMerge } from "../../services/git/merge-tree.js"
import type { GitPack } from "../../services/git/pack.js"
import { prepareGitCommit } from "../../services/git/write-tree.js"
import type { ConnectorMirrorSource } from "./connector-mirror.js"
import {
  assertConnectorMirrorBinding,
  assertConnectorMirrorScope,
} from "./connector-mirror.js"
import type { IngestPublishSource } from "./extraction-source.js"
import { workspaceGitRead } from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import { workspaceRootPath } from "./root-path.js"
import { resolveSemanticConflicts, type WriteOrigin } from "./semantic-merge.js"
import {
  deleteWriteJobRefs,
  findPreparedMergeCommit,
  prepareWithJobRef,
} from "./write-broker.js"
import type { WorkspaceWriteJobKind } from "./write-jobs.js"

type WorkspaceWriteCommand = {
  orgId: string
  workspaceId: string
  jobId: string
  revision: WorkspaceRevision
  files?: GitFileChange[]
  deletePaths?: string[]
  displayName?: string
  previousSha?: string
  extraction?: Record<string, unknown>
  ingest?: IngestPublishSource
  mirror?: ConnectorMirrorSource
}

/** Org and log scope only; the calling workflow owns all durable execution steps. */
export function withWorkspaceWriteContext<T>(
  input: Pick<WorkspaceWriteCommand, "orgId" | "workspaceId" | "jobId">,
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
  kind: WorkspaceWriteJobKind,
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
    !isDeepStrictEqual(recorded.payload?.mirror, input.mirror) ||
    !isDeepStrictEqual(recorded.payload?.extraction, input.extraction) ||
    !isDeepStrictEqual(recorded.payload?.ingest, input.ingest) ||
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

/**
 * Capture the immutable commit identity; no credential, directory, or Git
 * object is durable. The output holds no pack: each later step fetches the
 * commit from the Git host again (CTX-955).
 */
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
  const root = workspaceRootPath(revision)
  const pack: GitPack = {
    sha: revision.sha,
    objects: "",
    shallow: "",
    ...(root ? { root } : {}),
    base: {
      url: revision.remote.url,
      shas: [revision.sha, ...(previousSha ? [previousSha] : [])],
    },
  }
  if (input.mirror)
    await assertConnectorMirrorScope(
      input.mirror,
      pack,
      // The binding check above proves that `revision.remote` is the bound
      // repository.
      workspaceGitRead({ orgId: input.orgId, env, remote: revision.remote }),
    )
  return { pack, displayName: workspace.displayName }
}

/**
 * The `prepare-commit` step of a Workspace write (CTX-1235): stage, check,
 * and commit the change on the acquired revision, push the commit to its job
 * ref, and record it on the job. The output is the commit identity, never a
 * Git object. A fixed revision, change, subject, and `createdAt` give the
 * same commit again, so a replay pushes the same ref.
 */
export async function prepareWorkspaceWriteCommit(
  input: Pick<WorkspaceWriteCommand, "orgId" | "workspaceId" | "jobId">,
  revision: WorkspaceRevision,
  pack: GitPack,
  change: { files: readonly GitFileChange[]; deletePaths: readonly string[] },
  commit: { subject: string; createdAt: Date | string },
  env: Env,
) {
  return prepareWithJobRef(
    { ...input, remote: revision.remote },
    env,
    async (publish) => {
      const committed = await prepareGitCommit({
        pack,
        ...change,
        ...commit,
        // The acquire step proved that `revision.remote` is the bound
        // repository.
        read: workspaceGitRead({
          orgId: input.orgId,
          env,
          remote: revision.remote,
        }),
        publish,
      })
      await persistWriteJobPreparedCommit(input.jobId, committed.sha)
      return committed
    },
  )
}

/**
 * The `prepare-merge-commit` step of a semantic merge (CTX-1235): merge the
 * captured change onto the acquired tip, resolve each conflict with the
 * model, commit, push the commit to its job ref, and record it on the job.
 * Null when the merge changes nothing. The model can answer differently on a
 * replay, so a replay returns the commit that an earlier execution recorded:
 * a second answer cannot make a second commit.
 */
export async function prepareSemanticMergeCommit(
  input: Pick<
    WorkspaceWriteCommand,
    "orgId" | "workspaceId" | "jobId" | "revision" | "mirror" | "extraction"
  > & {
    origin: WriteOrigin
    previousSha: string
    files: GitFileChange[]
    deletePaths: string[]
    handoff?: { ownerRunId: string; candidateSha: string }
  },
  revision: WorkspaceRevision,
  pack: GitPack,
  commit: { subject: string; createdAt: Date | string },
  env: Env,
) {
  const job = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    remote: revision.remote,
    candidateSha: input.handoff?.candidateSha,
  }
  return prepareWithJobRef(job, env, async (publish) => {
    const found = await findPreparedMergeCommit(job, revision, env)
    if (found && "commit" in found) return found.commit
    // A commit that a run recorded before its steps got new names and never
    // pushed: no step reads it again.
    if (found) await discardWriteJobPreparedCommit(input.jobId, found.stale)
    const committed = await prepareGitMerge({
      pack,
      previousSha: input.previousSha,
      files: input.files,
      deletePaths: input.deletePaths,
      // A Markdown file that the model cannot resolve keeps both versions in
      // conflict markers, so the write is not lost (CTX-958). Hydrate skips
      // it and tells the user.
      resolve: (conflicts) =>
        resolveSemanticConflicts(conflicts, {
          origin: input.origin,
          flagUnresolved: true,
        }),
      ...commit,
      // The acquire step proved that `revision.remote` is the bound
      // repository.
      read: workspaceGitRead({
        orgId: input.orgId,
        env,
        remote: revision.remote,
      }),
      publish,
    })
    if (!committed) return null
    if (input.handoff)
      await validateSemanticHandoff(
        { ...input, handoff: input.handoff },
        committed.sha,
      )
    else await persistWriteJobPreparedCommit(input.jobId, committed.sha)
    return committed
  })
}

/**
 * The `complete` step of a Workspace write: record the result on the job and
 * delete the job refs of the job (CTX-1235). The tip check deletes the refs
 * of a job that ends another way.
 */
export async function completeWorkspaceWrite(
  job: Pick<WorkspaceWriteCommand, "orgId" | "workspaceId" | "jobId"> & {
    remote: WorkspaceRevision["remote"]
  },
  commitSha: string | null,
  env: Env,
) {
  await persistWriteJobCommitSha(job.jobId, commitSha)
  await deleteWriteJobRefs(job, env)
}
