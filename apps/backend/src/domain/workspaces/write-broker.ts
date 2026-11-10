import type { Env } from "../../config/env.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import { ingestionRunStates } from "../../models/ingestion-runs.js"
import {
  discardWriteJobPreparedCommit,
  getWriteJobRefState,
  listWriteJobStatuses,
  persistSemanticHandoff,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  getWorkspaceWriteAdmission,
  persistWriteStatus,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  gitRemoteEnvironment,
  resolveGitRemoteTip,
} from "../../services/git/clone-tree.js"
import {
  fetchGitCommits,
  type GitWriteCommit,
  nativeGit,
  type PublishGitCommit,
  readCommitHeader,
  readGitPackFromRemote,
  withGitDirectory,
  writeCommitPack,
} from "../../services/git/pack.js"
import { readUnbornRemoteBranch } from "../../services/git/unborn-tree.js"
import {
  cleanUpIngestRefs,
  deleteRemoteRefs,
  deleteRunIngestRefs,
  findStepCommit,
  IngestRefRefusedError,
  type IngestRemote,
  ingestRunRefTip,
  listRemoteRefs,
  listStepFiles,
  mergeIngestPublish,
  type PushIngestStepInput,
  parseIngestRef,
  pushIngestAssemble,
  pushIngestStep,
} from "../ingestion/ingest-refs.js"
import type { UnbornBootstrapBinding } from "./bootstrap-input.js"
import { getUnbornBootstrapWorkspace } from "./bootstrap-unborn.js"
import {
  assertConnectorMirrorBinding,
  assertConnectorMirrorScope,
  type ConnectorMirrorSource,
} from "./connector-mirror.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "./resolve-revision.js"
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"
import {
  gitChangesOutsideWorkspaceRoot,
  workspaceRootPath,
} from "./root-path.js"
import type { WriteOrigin } from "./semantic-merge.js"
import {
  githubRepoFullNameFromWorkspaceUrl,
  WRITE_STATUS_REASONS,
} from "./write-status.js"

class WorkspaceTipAdvancedError extends Error {
  constructor() {
    super("Default branch advanced; semantic merge is required")
  }
}

class WorkspaceWriteAccessUnavailableError extends Error {
  constructor(readonly readOnlyReason?: string) {
    super("Workspace default-branch write access is unavailable")
  }
}

/** Only a recognized remote access/protection denial pauses a native push. */
export function writeAccessDenialReason(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const detail = error as { status?: number; stderr?: Buffer | string }
  const stderr = detail.stderr?.toString() ?? ""
  if (
    /GH006:|GH013:|protected branch update failed|repository rule violations/i.test(
      stderr,
    )
  )
    return WRITE_STATUS_REASONS.protectedBranch
  if (
    detail.status === 401 ||
    detail.status === 403 ||
    detail.status === 404 ||
    /permission to .+ denied|requested URL returned error: (?:401|403)|authentication failed/i.test(
      stderr,
    )
  )
    return WRITE_STATUS_REASONS.contentsWriteDenied
  return null
}

/** Called inside the workflow's durable broker-push step. Credentials never leave it. */
export async function pushWorkspaceCommit(
  input: {
    orgId: string
    workspaceId: string
    mirror?: ConnectorMirrorSource
  },
  revision: WorkspaceRevision,
  committed: GitWriteCommit,
  env: Env,
): Promise<void> {
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const connectionId = revision.remote.connectionId
  if (!repositoryName || !connectionId)
    throw new Error("Workspace writes require a connected GitHub repository")
  const workspace = await getWorkspaceWriteAdmission(input.workspaceId)
  const current = workspace?.revision ?? null
  if (!workspace || !sameWriteBinding(current, revision))
    throw new Error("Workspace write binding changed before push")
  const readToken = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const tip = await resolveGitRemoteTip({
    url: revision.remote.url,
    token: readToken,
  })
  if (tip?.branch !== revision.defaultBranch)
    throw new Error("Default branch changed before push")
  if (await remoteContainsCommit(revision, committed.sha, tip.sha, readToken))
    return
  if (workspace.writeStatus !== "writable")
    throw new WorkspaceWriteAccessUnavailableError()
  if (tip.sha !== revision.sha || !sameWorkspaceRevision(current, revision))
    throw new WorkspaceTipAdvancedError()
  // The binding check above proves that `revision.remote` is the bound
  // repository.
  const read = { url: revision.remote.url, token: async () => readToken }
  if (input.mirror) {
    await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
    await assertConnectorMirrorScope(
      input.mirror,
      { ...writeCommitPack(committed, revision.remote.url), sha: revision.sha },
      read,
    )
  }
  const token = await getRepoWriteCloneToken(input.orgId, env, {
    githubConnectionId: connectionId,
    repoFullName: repositoryName,
  }).catch((error: unknown) => {
    const reason = writeAccessDenialReason(error)
    if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
    throw error
  })
  if (!token)
    throw new WorkspaceWriteAccessUnavailableError(
      WRITE_STATUS_REASONS.contentsWriteDenied,
    )
  await withGitDirectory(
    committed.sha,
    async (directory) => {
      // Recheck the actual default after remote credential I/O.
      const pushTip = await resolveGitRemoteTip({
        url: revision.remote.url,
        token,
      })
      if (pushTip?.branch !== revision.defaultBranch)
        throw new Error("Default branch changed during credential issuance")
      if (pushTip.sha !== revision.sha && pushTip.sha !== committed.sha)
        throw new WorkspaceTipAdvancedError()
      // Credential acquisition and pack restoration may outlive a relink.
      const live = await getWorkspaceWriteAdmission(input.workspaceId)
      if (!sameWorkspaceRevision(live?.revision, revision))
        throw new Error(
          "Workspace write binding changed during credential issuance",
        )
      if (pushTip.sha === committed.sha) return
      if (live?.writeStatus !== "writable")
        throw new WorkspaceWriteAccessUnavailableError()
      // Never push a change outside the Workspace root folder (CTX-709).
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
          "The commit changes files outside the Workspace root folder",
        )
      if (input.mirror)
        await assertConnectorMirrorBinding(input.orgId, input.mirror, revision)
      await nativeGit(
        directory,
        [
          "push",
          "--porcelain",
          "--",
          revision.remote.url,
          `${committed.sha}:refs/heads/${revision.defaultBranch}`,
        ],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      ).catch((error: unknown) => {
        const reason = writeAccessDenialReason(error)
        if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
        throw error
      })
    },
    // The commit comes from its job ref (CTX-1235).
    writeCommitPack(committed, revision.remote.url),
    read,
  )
}

function sameWriteBinding(
  current: WorkspaceRevision | null,
  revision: WorkspaceRevision,
): boolean {
  return Boolean(
    current &&
    sameWorkspaceRevision(current, {
      ...revision,
      sha: current.sha,
      access: current.access,
    }),
  )
}

/**
 * Whether the history of the remote tip holds `sha`, a commit on top of
 * `revision.sha`. The directory first gets `revision.sha` at depth 1, so the
 * fetch of the tip brings only the commits between the two, and exactly the
 * commits that the tip reaches: `sha` need not be on the remote.
 */
async function remoteContainsCommit(
  revision: { remote: WorkspaceRevision["remote"]; sha: string | null },
  sha: string,
  tipSha: string,
  token: string | undefined,
): Promise<boolean> {
  if (tipSha === sha) return true
  if (tipSha === revision.sha) return false
  return withGitDirectory(
    tipSha,
    async (directory) => {
      if (revision.sha)
        await fetchGitCommits(directory, {
          url: revision.remote.url,
          shas: [revision.sha],
          token,
        })
      await nativeGit(
        directory,
        ["fetch", "--", revision.remote.url, tipSha],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      )
      const found = await nativeGit(
        directory,
        ["cat-file", "--batch-check=%(objecttype)"],
        `${sha}\n`,
      )
      return found.toString().trim() === "commit"
    },
    undefined,
    null,
  )
}

export async function publishWorkspaceWriteRevision(
  input: {
    orgId: string
    workspaceId: string
    mirror?: ConnectorMirrorSource
  },
  revision: WorkspaceRevision,
  committed: GitWriteCommit,
  env: Env,
): Promise<WorkspaceRevision> {
  // A webhook or another writer may have advanced desired state after our push.
  // Reconcile the actual default and hydrate its canonical tip, retaining our job's commit identity.
  const resolved = await resolveWorkspaceReadRevision({
    ...input,
    env,
    refresh: true,
  })
  if (!resolved || !sameWriteBinding(resolved.revision, revision))
    throw new Error(
      "Workspace write binding changed before hydration publication",
    )
  if (
    !(await remoteContainsCommit(
      revision,
      committed.sha,
      resolved.revision.sha,
      resolved.token,
    ))
  )
    throw new Error(
      "The canonical default no longer contains the prepared write commit",
    )
  return resolved.revision
}

/** Revalidate a no-op against the actual default, outside any SQL transaction. */
export async function refreshWorkspaceWriteRevision(
  input: {
    orgId: string
    workspaceId: string
    mirror?: ConnectorMirrorSource
  },
  revision: WorkspaceRevision,
  env: Env,
): Promise<WorkspaceRevision> {
  const resolved = await resolveWorkspaceReadRevision({
    ...input,
    env,
    refresh: true,
  })
  const live = await getWorkspaceWriteAdmission(input.workspaceId)
  if (!resolved || !sameWriteBinding(resolved.revision, revision))
    throw new Error("Workspace write binding changed during no-op validation")
  if (
    !sameWorkspaceRevision(live?.revision, {
      ...resolved.revision,
      access: "write-default",
    })
  )
    throw new Error("Workspace revision changed during no-op validation")
  if (input.mirror) {
    await assertConnectorMirrorBinding(
      input.orgId,
      input.mirror,
      resolved.revision,
    )
    await assertConnectorMirrorScope(
      input.mirror,
      await readGitPackFromRemote({
        url: resolved.revision.remote.url,
        sha: resolved.revision.sha,
        token: resolved.token,
        root: workspaceRootPath(resolved.revision),
      }),
      null,
    )
  }
  return { ...resolved.revision, access: "write-default" }
}

/** Recoverable native push admission, evaluated inside the caller's durable broker step. */
export async function attemptWorkspaceCommit(
  ...args: Parameters<typeof pushWorkspaceCommit>
): Promise<
  { pushed: true } | { pushed: false; reason: "tip_advanced" | "paused" }
> {
  try {
    await pushWorkspaceCommit(...args)
    return { pushed: true }
  } catch (error) {
    if (error instanceof WorkspaceTipAdvancedError)
      return { pushed: false, reason: "tip_advanced" }
    if (error instanceof WorkspaceWriteAccessUnavailableError) {
      if (error.readOnlyReason) {
        const [input, revision] = args
        await persistWriteStatus(
          {
            id: input.workspaceId,
            desiredGeneration: revision.generation,
            workspaceRepositoryUrl: revision.remote.url,
            githubConnectionId: revision.remote.connectionId,
            desiredDefaultBranch: revision.defaultBranch,
            desiredSha: revision.sha,
          },
          { writeStatus: "read_only", readOnlyReason: error.readOnlyReason },
          input.orgId,
        )
      }
      return { pushed: false, reason: "paused" }
    }
    throw error
  }
}

/**
 * Capture the unpushed write and the current binding as an immutable child
 * command. The child input names the candidate commit on its job ref, never
 * its files (CTX-1239): the child reads the change from Git.
 */
export async function captureSemanticHandoff(
  input: {
    orgId: string
    workspaceId: string
    jobId: string
    mirror?: ConnectorMirrorSource
  },
  revision: WorkspaceRevision,
  committed: GitWriteCommit,
  env: Env,
  origin: WriteOrigin,
  /** Paths of the change that must not go onto the new tip. */
  dropPaths?: (nextRevision: WorkspaceRevision) => Promise<string[]>,
) {
  const nextRevision = await refreshWorkspaceWriteRevision(input, revision, env)
  const dropped = dropPaths ? await dropPaths(nextRevision) : []
  const handoff = await persistSemanticHandoff({
    jobId: input.jobId,
    revision,
    nextRevision,
    candidateSha: committed.sha,
    ...(dropped.length ? { dropPaths: dropped } : {}),
    mirror: input.mirror,
  })
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    origin,
    handoff: {
      ownerRunId: handoff.ownerRunId,
      candidateSha: handoff.candidateSha,
      ...(handoff.dropPaths ? { dropPaths: handoff.dropPaths } : {}),
    },
    revision: handoff.revision,
    previousSha: revision.sha,
    ...(input.mirror ? { mirror: input.mirror } : {}),
  }
}

type UnbornPushResult =
  | { kind: "pushed" }
  | { kind: "paused" }
  | { kind: "initialized"; revision: WorkspaceRevision }

/** First-root publication uses the same broker-only credentials and non-force push. */
export async function pushUnbornWorkspaceCommit(
  input: {
    orgId: string
    workspaceId: string
    bootstrapBinding: UnbornBootstrapBinding
  },
  committed: GitWriteCommit,
  env: Env,
): Promise<UnbornPushResult> {
  const binding = input.bootstrapBinding
  const workspace = await getUnbornBootstrapWorkspace(binding)
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(binding.remote.url)
  const connectionId = binding.remote.connectionId
  if (!repositoryName || !connectionId)
    throw new Error("Bootstrap requires a connected GitHub repository")
  const readToken = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: binding.remote,
  })
  const inspectInitialized = async (tip: {
    sha: string
    branch: string
  }): Promise<UnbornPushResult> => {
    if (tip.branch !== binding.defaultBranch)
      throw new Error("Default branch changed before bootstrap push")
    if (
      await remoteContainsCommit(
        { remote: binding.remote, sha: null },
        committed.sha,
        tip.sha,
        readToken,
      )
    )
      return { kind: "pushed" }
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env,
      refresh: true,
    })
    await getUnbornBootstrapWorkspace(binding)
    if (
      !resolved ||
      resolved.revision.generation !== binding.generation ||
      resolved.revision.remote.url !== binding.remote.url ||
      resolved.revision.remote.connectionId !== binding.remote.connectionId ||
      resolved.revision.defaultBranch !== binding.defaultBranch
    )
      throw new Error(
        "Bootstrap binding changed after repository initialization",
      )
    return {
      kind: "initialized",
      revision: { ...resolved.revision, access: "write-default" },
    }
  }
  const tip = await resolveGitRemoteTip({
    url: binding.remote.url,
    token: readToken,
  })
  if (tip) return inspectInitialized(tip)
  if (workspace.writeStatus !== "writable") return { kind: "paused" }
  if (workspace.desiredSha !== null)
    throw new Error("Bootstrap revision changed before push")
  try {
    const token = await getRepoWriteCloneToken(input.orgId, env, {
      githubConnectionId: connectionId,
      repoFullName: repositoryName,
    })
    if (!token)
      throw new WorkspaceWriteAccessUnavailableError(
        WRITE_STATUS_REASONS.contentsWriteDenied,
      )
    return await withGitDirectory(
      committed.sha,
      async (directory): Promise<UnbornPushResult> => {
        const branch = await readUnbornRemoteBranch({
          url: binding.remote.url,
          token,
        })
        if (branch !== binding.defaultBranch) {
          const initialized = await resolveGitRemoteTip({
            url: binding.remote.url,
            token: readToken,
          })
          if (initialized) return inspectInitialized(initialized)
          throw new Error(
            "Bootstrap default changed during credential issuance",
          )
        }
        const live = await getUnbornBootstrapWorkspace(binding)
        if (live.desiredSha !== null)
          throw new Error(
            "Bootstrap revision changed during credential issuance",
          )
        if (live.writeStatus !== "writable")
          throw new WorkspaceWriteAccessUnavailableError()
        await nativeGit(
          directory,
          [
            "push",
            "--porcelain",
            "--",
            binding.remote.url,
            `${committed.sha}:refs/heads/${binding.defaultBranch}`,
          ],
          undefined,
          gitRemoteEnvironment({ url: binding.remote.url, token }),
        )
        return { kind: "pushed" }
      },
      // The commit comes from its job ref (CTX-1235).
      writeCommitPack(committed, binding.remote.url),
      { url: binding.remote.url, token: async () => readToken },
    )
  } catch (error) {
    const reason =
      error instanceof WorkspaceWriteAccessUnavailableError
        ? error.readOnlyReason
        : writeAccessDenialReason(error)
    if (!reason && !(error instanceof WorkspaceWriteAccessUnavailableError)) {
      const initialized = await resolveGitRemoteTip({
        url: binding.remote.url,
        token: readToken,
      })
      if (initialized) return inspectInitialized(initialized)
      throw error
    }
    if (reason)
      await persistWriteStatus(
        {
          id: workspace.id,
          desiredGeneration: binding.generation,
          workspaceRepositoryUrl: binding.remote.url,
          githubConnectionId: binding.remote.connectionId,
          desiredSha: workspace.desiredSha,
          desiredDefaultBranch: workspace.desiredDefaultBranch,
        },
        { writeStatus: "read_only", readOnlyReason: reason },
        input.orgId,
      )
    return { kind: "paused" }
  }
}

/** The job of a ref push: its run, its Workspace, and the Workspace binding it read. */
type IngestBrokerJob = {
  runId: string
  workspaceId: string
  /** The Workspace generation that the run resolved. A relink changes it. */
  generation: number
}

type AdmittedIngestRemote = {
  url: string
  connectionId: string
  repositoryName: string
  rootPath: string
}

/**
 * Admission of an ingest ref job, before any credential (ADR-052 section 6).
 * The job names a run and a Workspace, never a URL, so it can only reach the
 * Workspace repository. The run must be an unfinished ingestion v2 run of the
 * org. The Workspace must be writable, with the same binding as the job.
 */
async function admitIngestJob(
  orgId: string,
  workspaceId: string,
  job?: IngestBrokerJob,
): Promise<AdmittedIngestRemote> {
  if (job) {
    const run = (await ingestionRunStates(orgId, [job.runId])).get(job.runId)
    if (!run?.unfinished)
      throw new IngestRefRefusedError(
        "The job's run is not an unfinished ingestion run of the org",
        ["admission"],
      )
  }
  const workspace = await getWorkspaceWriteAdmission(workspaceId, orgId)
  if (!workspace)
    throw new IngestRefRefusedError("The Workspace is not bound in the org", [
      "admission",
    ])
  if (workspace.writeStatus !== "writable")
    throw new IngestRefRefusedError("The Workspace is not writable", [
      "admission",
    ])
  if (job && workspace.revision.generation !== job.generation)
    throw new IngestRefRefusedError("The Workspace binding changed", [
      "admission",
    ])
  const { url, connectionId } = workspace.revision.remote
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(url)
  if (!repositoryName || !connectionId)
    throw new IngestRefRefusedError(
      "Ingest refs require a connected GitHub repository",
      ["admission"],
    )
  return {
    url,
    connectionId,
    repositoryName,
    rootPath: workspaceRootPath(workspace.revision),
  }
}

/** A connected GitHub repository that an admission names. */
type BrokerRemote = Pick<
  AdmittedIngestRemote,
  "url" | "connectionId" | "repositoryName"
>

async function brokerWriteRemote(
  orgId: string,
  remote: BrokerRemote,
  env: Env,
): Promise<IngestRemote> {
  const token = await getRepoWriteCloneToken(orgId, env, {
    githubConnectionId: remote.connectionId,
    repoFullName: remote.repositoryName,
  }).catch((error: unknown) => {
    const reason = writeAccessDenialReason(error)
    if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
    throw error
  })
  if (!token)
    throw new WorkspaceWriteAccessUnavailableError(
      WRITE_STATUS_REASONS.contentsWriteDenied,
    )
  return {
    url: remote.url,
    env: gitRemoteEnvironment({ url: remote.url, token }),
  }
}

async function brokerReadRemote(
  orgId: string,
  remote: BrokerRemote,
  env: Env,
): Promise<IngestRemote> {
  const token = await resolveRepositoryReadCredential({
    orgId,
    env,
    remote: { url: remote.url, connectionId: remote.connectionId },
  })
  return {
    url: remote.url,
    env: gitRemoteEnvironment({ url: remote.url, token }),
  }
}

/** The ingest step job kind: push one validated step commit to a run-scoped ref. */
export async function pushWorkspaceIngestStep(
  input: Omit<PushIngestStepInput, "remote" | "job"> & {
    orgId: string
    job: IngestBrokerJob
  },
  env: Env,
) {
  const admitted = await admitIngestJob(
    input.orgId,
    input.job.workspaceId,
    input.job,
  )
  const remote = await brokerWriteRemote(input.orgId, admitted, env)
  // The root folder comes from the Workspace, never from the caller.
  return pushIngestStep({
    ...input,
    patch: { ...input.patch, rootPath: admitted.rootPath },
    remote,
  })
}

/**
 * The publish job kind (T21): the files of a run's publish on the current
 * default tip, read only. The Workspace must be writable and bound in the org.
 * A replay can come after the run finished, so the run need not be
 * unfinished: the `Ctxpipe-Run` trailer of the tip binds the tip to the run.
 */
export async function mergeWorkspaceIngestPublish(
  input: Omit<Parameters<typeof mergeIngestPublish>[0], "remote"> & {
    orgId: string
    workspaceId: string
  },
  env: Env,
) {
  const admitted = await admitIngestJob(input.orgId, input.workspaceId)
  const remote = await brokerReadRemote(input.orgId, admitted, env)
  return mergeIngestPublish({ ...input, remote })
}

/** The assemble job kind: merge the shard tips into the assembled ref. */
export async function pushWorkspaceIngestAssemble(
  input: Omit<Parameters<typeof pushIngestAssemble>[0], "remote" | "job"> & {
    orgId: string
    job: IngestBrokerJob
  },
  env: Env,
) {
  const admitted = await admitIngestJob(
    input.orgId,
    input.job.workspaceId,
    input.job,
  )
  const remote = await brokerWriteRemote(input.orgId, admitted, env)
  return pushIngestAssemble({ ...input, rootPath: admitted.rootPath, remote })
}

/** The read remote of an ingest ref, after the check that the ref is the job's. */
async function ingestRefReadRemote(
  input: { orgId: string; job: IngestBrokerJob; ref: string },
  env: Env,
): Promise<IngestRemote> {
  const target = parseIngestRef(input.ref)
  if (
    target?.runId !== input.job.runId ||
    target.workspaceId !== input.job.workspaceId
  )
    throw new IngestRefRefusedError(
      "The ref is not an ingest ref of the job's run and Workspace",
    )
  const admitted = await admitIngestJob(
    input.orgId,
    input.job.workspaceId,
    input.job,
  )
  return brokerReadRemote(input.orgId, admitted, env)
}

/**
 * Resume: the commit of `step` on `ref` after `since`, when a step crashed
 * after its push or another execution pushed it; else the tip that another
 * execution moved the ref to, or null. T09 calls it before the model run of
 * each step.
 */
export async function findWorkspaceStepCommit(
  input: {
    orgId: string
    job: IngestBrokerJob
    ref: string
    step: string
    since: string
  },
  env: Env,
): ReturnType<typeof findStepCommit> {
  return findStepCommit({
    remote: await ingestRefReadRemote(input, env),
    ref: input.ref,
    runId: input.job.runId,
    step: input.step,
    since: input.since,
  })
}

/**
 * The tip of the job's ref (read only): `given`, or a later commit of the run
 * that another execution of the same child pushed (CTX-1073). A missing ref
 * gives `given`.
 */
export async function readWorkspaceIngestRunTip(
  input: { orgId: string; job: IngestBrokerJob; ref: string; given: string },
  env: Env,
): Promise<string> {
  return ingestRunRefTip({
    remote: await ingestRefReadRemote(input, env),
    ref: input.ref,
    runId: input.job.runId,
    given: input.given,
  })
}

/**
 * The paths that each step commit of the job's run wrote, from the pinned
 * revision to `tip` (read only). The repository-wide steps build the
 * root-to-file map from it.
 */
export async function listWorkspaceIngestStepFiles(
  input: {
    orgId: string
    job: IngestBrokerJob
    pinnedRevision: string
    tip: string
  },
  env: Env,
): Promise<Array<{ step: string; paths: string[] }>> {
  const admitted = await admitIngestJob(
    input.orgId,
    input.job.workspaceId,
    input.job,
  )
  return listStepFiles({
    remote: await brokerReadRemote(input.orgId, admitted, env),
    runId: input.job.runId,
    pinnedRevision: input.pinnedRevision,
    tip: input.tip,
  })
}

/** Deletes the run's refs in its Workspace repository. Idempotent. */
export async function deleteWorkspaceIngestRefs(
  input: { orgId: string; job: IngestBrokerJob },
  env: Env,
): Promise<string[]> {
  const admitted = await admitIngestJob(
    input.orgId,
    input.job.workspaceId,
    input.job,
  )
  return deleteRunIngestRefs({
    remote: await brokerWriteRemote(input.orgId, admitted, env),
    runId: input.job.runId,
    workspaceId: input.job.workspaceId,
  })
}

/**
 * The stale ingest ref clean-up of the Workspace tip check. It lists with the
 * read credential and asks for the write credential only to delete.
 */
export async function cleanUpWorkspaceIngestRefs(
  input: { orgId: string; workspaceId: string; now: Date },
  env: Env,
): Promise<string[]> {
  const admitted = await admitIngestJob(input.orgId, input.workspaceId)
  const { deleted } = await cleanUpIngestRefs({
    remote: await brokerReadRemote(input.orgId, admitted, env),
    pushRemote: () => brokerWriteRemote(input.orgId, admitted, env),
    now: input.now,
    runStates: (runIds) => ingestionRunStates(input.orgId, runIds),
  })
  return deleted
}

const WRITE_REF_ROOT = "refs/ctxpipe/write/"
const WRITE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * The job ref of a Workspace write commit: `refs/ctxpipe/write/<jobId>/<sha>`
 * (CTX-1235). The SHA is in the name, so the ref never moves: a replay
 * pushes the same ref again, and a second execution of the run cannot
 * replace it. The GitHub webhook ignores `refs/ctxpipe/*`.
 */
export function writeJobRef(jobId: string, sha: string): string {
  if (!WRITE_JOB_ID.test(jobId) || !FULL_SHA.test(sha))
    throw new Error("A write job ref needs a plain job id and a full SHA")
  return `${WRITE_REF_ROOT}${jobId}/${sha}`
}

function parseWriteJobRef(name: string): { jobId: string; sha: string } | null {
  if (!name.startsWith(WRITE_REF_ROOT)) return null
  const [jobId = "", sha = "", ...rest] = name
    .slice(WRITE_REF_ROOT.length)
    .split("/")
  return !rest.length && WRITE_JOB_ID.test(jobId) && FULL_SHA.test(sha)
    ? { jobId, sha }
    : null
}

/** A write job: its org, its Workspace, and the remote that its run reads. */
type WriteJob = {
  orgId: string
  workspaceId: string
  jobId: string
  remote: { url: string; connectionId: string | null }
}

/**
 * The checks that a job ref push of a write job needs before any content
 * leaves the worker. `guard` adds the checks of the job kind (the binding and
 * the scope of a connector mirror).
 */
type WriteJobPush = WriteJob & { guard?: () => Promise<void> }

/**
 * Admission of the job refs of a write job, before any credential
 * (CTX-1235). The job names a Workspace, never a URL: the URL comes from the
 * Workspace row, so a job reaches only the Workspace repository. The job must
 * be a job of that Workspace in the org, and the Workspace must still be
 * bound to the remote that the run reads.
 */
async function admitWriteJob(job: WriteJob) {
  const state = await getWriteJobRefState(job.jobId)
  if (!state || state.workspaceId !== job.workspaceId)
    throw new Error("The write job is not a job of the Workspace")
  const workspace = await getWorkspaceById(job.workspaceId, job.orgId)
  if (
    !workspace ||
    workspace.workspaceRepositoryUrl !== job.remote.url ||
    workspace.githubConnectionId !== job.remote.connectionId
  )
    throw new Error("Workspace write binding changed")
  const remote = workspaceBrokerRemote(workspace)
  if (!remote)
    throw new Error("Write job refs require a connected GitHub repository")
  return { state, workspace, remote }
}

/** The connected GitHub repository of a Workspace row, or null. */
function workspaceBrokerRemote(workspace: {
  workspaceRepositoryUrl: string
  githubConnectionId: string | null
}): BrokerRemote | null {
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    workspace.workspaceRepositoryUrl,
  )
  return repositoryName && workspace.githubConnectionId
    ? {
        url: workspace.workspaceRepositoryUrl,
        connectionId: workspace.githubConnectionId,
        repositoryName,
      }
    : null
}

/**
 * Run a write step that pushes its commit to a job ref (CTX-1235). `prepare`
 * gets the publisher: the broker is the only pusher, and the credential never
 * leaves it. When the Workspace has no write access, the result is `paused`,
 * as for `attemptWorkspaceCommit`; a denial that GitHub names makes the
 * Workspace read-only.
 */
async function prepareWithJobRef<T>(
  job: WriteJobPush,
  env: Env,
  prepare: (publish: PublishGitCommit) => Promise<T>,
): Promise<T | "paused"> {
  const admitActive = async () => {
    const admitted = await admitWriteJob(job)
    if (
      admitted.state.status !== "running" &&
      admitted.state.status !== "paused"
    )
      throw new Error("The write job is not active")
    if (admitted.workspace.writeStatus !== "writable")
      throw new WorkspaceWriteAccessUnavailableError()
    return admitted
  }
  const publish: PublishGitCommit = async (directory, sha) => {
    const admitted = await admitActive()
    const remote = await brokerWriteRemote(job.orgId, admitted.remote, env)
    await job.guard?.()
    // A detach, a relink, or a lost write access can come while GitHub
    // issues the credential or while the guard reads: check again last,
    // before any content leaves.
    await admitActive()
    await nativeGit(
      directory,
      [
        "push",
        "--porcelain",
        "--",
        remote.url,
        `${sha}:${writeJobRef(job.jobId, sha)}`,
      ],
      undefined,
      remote.env,
    ).catch((error: unknown) => {
      const reason = writeAccessDenialReason(error)
      if (reason) throw new WorkspaceWriteAccessUnavailableError(reason)
      throw error
    })
  }
  try {
    return await prepare(publish)
  } catch (error) {
    if (!(error instanceof WorkspaceWriteAccessUnavailableError)) throw error
    const workspace = error.readOnlyReason
      ? await getWorkspaceById(job.workspaceId, job.orgId)
      : null
    if (workspace && error.readOnlyReason)
      await persistWriteStatus(
        workspace,
        { writeStatus: "read_only", readOnlyReason: error.readOnlyReason },
        job.orgId,
      )
    return "paused"
  }
}

/**
 * The commit that an earlier execution of a prepare step recorded for the job
 * (CTX-1235, CTX-1239). The step records its commit on the job before the
 * push to the job ref, so each pushed commit is recorded. A recorded commit
 * that the default branch has is the result too (a run that pushed before
 * its steps got new names). Else the recorded commit was never pushed, and
 * `stale` names it. `candidateSha` is the commit of a parent run that a
 * handoff child starts from; it is not a result. `parent` is the commit that
 * the step writes on, or null for the first commit of an unborn repository.
 */
async function findPreparedCommit(
  job: WriteJob & { candidateSha?: string },
  parent: { sha: string | null; root: string },
  env: Env,
): Promise<{ commit: GitWriteCommit } | { stale: string } | null> {
  const admitted = await admitWriteJob(job)
  const recorded = admitted.state.commitSha
  if (!recorded || recorded === job.candidateSha) return null
  const token = await resolveRepositoryReadCredential({
    orgId: job.orgId,
    env,
    remote: job.remote,
  })
  const ref = writeJobRef(job.jobId, recorded)
  const onRef = (
    await listRemoteRefs(
      {
        url: job.remote.url,
        env: gitRemoteEnvironment({ url: job.remote.url, token }),
      },
      ref,
    )
  ).some((listed) => listed.name === ref && listed.sha === recorded)
  const tip = onRef
    ? null
    : await resolveGitRemoteTip({ url: job.remote.url, token })
  if (
    !onRef &&
    !(
      tip &&
      (await remoteContainsCommit(
        { remote: job.remote, sha: parent.sha },
        recorded,
        tip.sha,
        token,
      ))
    )
  )
    return { stale: recorded }
  const commit: GitWriteCommit = {
    sha: recorded,
    tree: "",
    ...(parent.root ? { root: parent.root } : {}),
    base: parent.sha,
  }
  const { tree, parents } = await withGitDirectory(
    recorded,
    (directory) => readCommitHeader(directory, recorded),
    writeCommitPack(commit, job.remote.url),
    { url: job.remote.url, token: async () => token },
  )
  if (parents.join() !== (parent.sha ?? ""))
    throw new Error(
      "The recorded commit of the write job is not a commit on its revision",
    )
  return { commit: { ...commit, tree } }
}

/**
 * Run the prepare step of a Workspace write (CTX-1235, CTX-1239): the step
 * makes the content of the write (a transform, a merge, or a model answer),
 * commits it, records the commit on the job, and pushes it to its job ref.
 * The step output is the result of `build`: a commit identity and small
 * metadata, never a file or a Git object.
 *
 * A model can answer differently on a replay, so a replay returns the
 * commit that an earlier execution recorded and pushed (`reuse`): a second
 * answer cannot make a second commit. A recorded commit that no push sent is
 * discarded, and `build` runs again. `record` replaces the default record of
 * the commit on the job (a semantic handoff child records on its parent's
 * job).
 */
export async function prepareRecordedCommit<T>(
  job: WriteJobPush & { candidateSha?: string },
  parent: { sha: string | null; root: string },
  env: Env,
  steps: {
    build: (publish: PublishGitCommit) => Promise<T>
    reuse: (commit: GitWriteCommit) => T
    record?: (sha: string) => Promise<unknown>
  },
): Promise<T | "paused"> {
  const record =
    steps.record ??
    ((sha: string) => persistWriteJobPreparedCommit(job.jobId, sha))
  return prepareWithJobRef(job, env, async (publish) => {
    const found = await findPreparedCommit(job, parent, env)
    if (found && "commit" in found) return steps.reuse(found.commit)
    // A crash between the record and the push, or a run from before the
    // new step names: no step reads the recorded commit.
    if (found) await discardWriteJobPreparedCommit(job.jobId, found.stale)
    // Record the commit before its push: a commit on a job ref is always
    // the recorded one, so a replay finds it and asks no model again.
    return steps.build(async (directory, sha) => {
      await record(sha)
      await publish(directory, sha)
    })
  })
}

/**
 * Deletes the job refs of a write job (the `complete` step). A failure only
 * logs: the tip check deletes the refs later.
 */
export async function deleteWriteJobRefs(job: WriteJob, env: Env) {
  try {
    const admitted = await admitWriteJob(job)
    const refs = await listRemoteRefs(
      await brokerReadRemote(job.orgId, admitted.remote, env),
      `${WRITE_REF_ROOT}${job.jobId}/`,
    )
    if (refs.length)
      await deleteRemoteRefs(
        await brokerWriteRemote(job.orgId, admitted.remote, env),
        refs,
      )
  } catch (error) {
    getLogger().warn("The job refs of a write job were not deleted", {
      step: "workspace.write_job_ref_cleanup",
      workspaceId: job.workspaceId,
      jobId: job.jobId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The stale write job ref clean-up of the Workspace tip check (CTX-1235): the
 * refs of a completed or a failed job of the org. An active job keeps its
 * refs, and so does a ref of an unknown job: a repository can hold the refs
 * of a Workspace of another org, and the age of a commit does not tell if
 * its job is active. It lists with the read credential and asks for the
 * write credential only to delete.
 */
export async function cleanUpWorkspaceWriteRefs(
  input: { orgId: string; workspaceId: string },
  env: Env,
): Promise<string[]> {
  const workspace = await getWorkspaceById(input.workspaceId, input.orgId)
  const remote = workspace ? workspaceBrokerRemote(workspace) : null
  if (!remote) return []
  const read = await brokerReadRemote(input.orgId, remote, env)
  const refs = (await listRemoteRefs(read, WRITE_REF_ROOT)).map((ref) => ({
    ...ref,
    target: parseWriteJobRef(ref.name),
  }))
  if (!refs.length) return []
  const statuses = await listWriteJobStatuses([
    ...new Set(refs.flatMap((ref) => (ref.target ? [ref.target.jobId] : []))),
  ])
  const stale = refs.filter((ref) => {
    const status = ref.target ? statuses.get(ref.target.jobId) : undefined
    return status === "completed" || status === "failed"
  })
  if (!stale.length) return []
  return (
    await deleteRemoteRefs(
      await brokerWriteRemote(input.orgId, remote, env),
      stale,
    )
  ).deleted
}
