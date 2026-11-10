import { isDeepStrictEqual } from "node:util"

import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobPreparedCommit,
  reconcileWorkspaceWriteJob,
  validateSemanticHandoff,
} from "../../models/workspace-write-jobs.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { resolveGitRemoteTip } from "../../services/git/clone-tree.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import { prepareGitMerge } from "../../services/git/merge-tree.js"
import {
  type GitPack,
  type GitRemoteRead,
  type GitWriteCommit,
  writeCommitPack,
} from "../../services/git/pack.js"
import { prepareUnbornGitCommit } from "../../services/git/unborn-tree.js"
import {
  prepareGitCommit,
  readGitCommitChanges,
} from "../../services/git/write-tree.js"
import type { UnbornBootstrapBinding } from "./bootstrap-input.js"
import { getUnbornBootstrapWorkspace } from "./bootstrap-unborn.js"
import { generateCommitSubject } from "./commit-subject.js"
import { connectorMirrorContentSchema } from "./connector-mirror-input.js"
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
import { deleteWriteJobRefs, prepareRecordedCommit } from "./write-broker.js"
import type { WorkspaceWriteJobKind } from "./write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

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

/** The files that a write changes and deletes, relative to the Workspace root folder. */
type WriteChange = { files: GitFileChange[]; deletePaths: string[] }

/** The subject line of a write commit, from the names of the changed files. */
function writeCommitSubject(
  remote: WorkspaceRevision["remote"],
  trigger: string,
  change: WriteChange,
) {
  const repositoryName =
    githubRepoFullNameFromWorkspaceUrl(remote.url) ?? remote.url
  return generateCommitSubject({
    repoName: repositoryName.split("/")[1] ?? repositoryName,
    trigger,
    fileNames: [
      ...change.files.map((file) => file.path),
      ...change.deletePaths,
    ],
  })
}

/**
 * The `prepare-commit` step of a Workspace write (CTX-1235, CTX-1239): make
 * the change on the acquired revision (`change`), name it, commit it, record
 * it on the job, and push it to its job ref. The output is the commit
 * identity, never a file or a Git object; a later step reads the commit from
 * Git. Null when the change changes nothing. `change` can also stop the
 * write with a small outcome. A replay returns the commit that an earlier
 * execution pushed, also when `change` or the subject model answers
 * differently now.
 */
export async function prepareWorkspaceWriteCommit<
  Change extends WriteChange | { stopped: unknown },
>(
  input: Pick<
    WorkspaceWriteCommand,
    "orgId" | "workspaceId" | "jobId" | "mirror"
  >,
  revision: WorkspaceRevision,
  pack: GitPack,
  write: {
    change: () => Promise<Change>
    /** A fixed subject, or the trigger of a generated subject. */
    subject: string | { trigger: string }
    createdAt: Date | string
  },
  env: Env,
): Promise<GitWriteCommit | Exclude<Change, WriteChange> | null | "paused"> {
  // The acquire step proved that `revision.remote` is the bound repository.
  const read = workspaceGitRead({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  return prepareRecordedCommit(
    {
      ...input,
      remote: revision.remote,
      guard: mirrorGuard(input, revision, pack, read),
    },
    { sha: revision.sha, root: pack.root ?? "" },
    env,
    {
      build: async (publish) => {
        const change: WriteChange | { stopped: unknown } = await write.change()
        if ("stopped" in change) return change as Exclude<Change, WriteChange>
        if (!change.files.length && !change.deletePaths.length) return null
        return prepareGitCommit({
          pack,
          ...change,
          subject:
            typeof write.subject === "string"
              ? write.subject
              : await writeCommitSubject(
                  revision.remote,
                  write.subject.trigger,
                  change,
                ),
          createdAt: write.createdAt,
          read,
          publish,
        })
      },
    },
  )
}

type SemanticMergeCommand = Pick<
  WorkspaceWriteCommand,
  "orgId" | "workspaceId" | "jobId" | "revision" | "mirror" | "extraction"
> & {
  origin: WriteOrigin
  previousSha: string
  files?: GitFileChange[]
  deletePaths?: string[]
  handoff?: { ownerRunId: string; candidateSha: string; dropPaths?: string[] }
}

/**
 * The change that a semantic merge puts onto the tip: the files of its
 * input, or for a handoff child the change of the parent's candidate commit
 * on its job ref (CTX-1239), without the dropped paths.
 */
export async function readSemanticMergeChange(
  input: SemanticMergeCommand,
  read: GitRemoteRead,
): Promise<WriteChange> {
  // A standalone merge, or a handoff from before CTX-1239, has its files.
  if (input.files)
    return { files: input.files, deletePaths: input.deletePaths ?? [] }
  if (!input.handoff) throw new Error("A semantic merge needs its change")
  const root = workspaceRootPath(input.revision)
  const delta = await readGitCommitChanges(
    writeCommitPack(
      {
        sha: input.handoff.candidateSha,
        tree: "",
        ...(root ? { root } : {}),
        base: input.previousSha,
      },
      read.url,
    ),
    input.previousSha,
    read,
  )
  const dropped = new Set(input.handoff.dropPaths)
  const change = {
    files: delta.files.filter((file) => !dropped.has(file.path)),
    deletePaths: delta.deletePaths.filter((path) => !dropped.has(path)),
  }
  if (
    input.mirror &&
    !connectorMirrorContentSchema.safeParse({ mirror: input.mirror, ...change })
      .success
  )
    throw new Error("Connector handoff must retain its managed paths")
  return change
}

/**
 * The `prepare-merge-commit` step of a semantic merge (CTX-1235): merge the
 * change onto the acquired tip, resolve each conflict with the model,
 * commit, push the commit to its job ref, and record it on the job. Null
 * when the merge changes nothing. As in `prepareWorkspaceWriteCommit`, a
 * replay returns the pushed commit: a second model answer cannot make a
 * second commit.
 */
export async function prepareSemanticMergeCommit(
  input: SemanticMergeCommand,
  revision: WorkspaceRevision,
  pack: GitPack,
  createdAt: Date | string,
  env: Env,
) {
  // The acquire step proved that `revision.remote` is the bound repository.
  const read = workspaceGitRead({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const { handoff } = input
  return prepareRecordedCommit(
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      remote: revision.remote,
      candidateSha: handoff?.candidateSha,
      guard: mirrorGuard(input, revision, pack, read),
    },
    { sha: revision.sha, root: pack.root ?? "" },
    env,
    {
      build: async (publish) => {
        const change = await readSemanticMergeChange(input, read)
        return prepareGitMerge({
          pack,
          previousSha: input.previousSha,
          ...change,
          // A Markdown file that the model cannot resolve keeps both
          // versions in conflict markers, so the write is not lost
          // (CTX-958). Hydrate skips it and tells the user.
          resolve: (conflicts) =>
            resolveSemanticConflicts(conflicts, {
              origin: input.origin,
              flagUnresolved: true,
            }),
          subject: await writeCommitSubject(
            revision.remote,
            "semantic_merge",
            change,
          ),
          createdAt,
          read,
          publish,
        })
      },
      record: (sha) =>
        handoff
          ? validateSemanticHandoff({ ...input, handoff }, sha)
          : persistWriteJobPreparedCommit(input.jobId, sha),
    },
  )
}

/**
 * The `prepare-commit-unborn` step of a bootstrap (CTX-1235, CTX-1239):
 * make the first commit of an unborn repository, push it to its job ref,
 * and record it on the job. The output is the commit identity.
 */
export async function prepareUnbornWorkspaceCommit(
  input: Pick<WorkspaceWriteCommand, "orgId" | "workspaceId" | "jobId"> & {
    bootstrapBinding: UnbornBootstrapBinding
  },
  write: {
    files: (displayName: string) => GitFileChange[]
    allowedPath: (path: string) => boolean
    createdAt: Date | string
  },
  env: Env,
) {
  const binding = input.bootstrapBinding
  const root = workspaceRootPath(binding)
  return prepareRecordedCommit(
    { ...input, remote: binding.remote },
    { sha: null, root },
    env,
    {
      build: async (publish) => {
        const workspace = await getUnbornBootstrapWorkspace(binding)
        const files = write.files(workspace.displayName)
        return prepareUnbornGitCommit({
          files,
          root,
          allowedPaths: files
            .map((file) => file.path)
            .filter(write.allowedPath),
          subject: await writeCommitSubject(binding.remote, "bootstrap", {
            files,
            deletePaths: [],
          }),
          createdAt: write.createdAt,
          publish,
        })
      },
    },
  )
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

/**
 * A connector mirror pushes its job ref only while its connector is still
 * bound to the Workspace and its scope is active, as the broker push checks
 * (CTX-1235): a captured page must not reach a repository that the connector
 * left.
 */
function mirrorGuard(
  input: Pick<WorkspaceWriteCommand, "orgId" | "mirror">,
  revision: WorkspaceRevision,
  pack: GitPack,
  read: GitRemoteRead,
) {
  const { mirror } = input
  if (!mirror) return undefined
  return async () => {
    await assertConnectorMirrorBinding(input.orgId, mirror, revision)
    // The scope can change on the default branch after the acquire step:
    // check it on the live tip.
    const tip = await resolveGitRemoteTip({
      url: read.url,
      token: await read.token(),
    })
    if (tip?.branch !== revision.defaultBranch)
      throw new Error("Default branch changed before the job ref push")
    await assertConnectorMirrorScope(
      mirror,
      {
        ...pack,
        sha: tip.sha,
        objects: "",
        shallow: "",
        base: { url: read.url, shas: [tip.sha] },
      },
      read,
    )
    // A reset or a rebind of the connector can come during that fetch.
    await assertConnectorMirrorBinding(input.orgId, mirror, revision)
  }
}
