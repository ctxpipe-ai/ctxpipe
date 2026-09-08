import { parseEnv } from "../config/env.js"
import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import {
  type EnqueueWriteJobInput,
  WRITE_JOB_STATUSES,
  writeJobIntentPayload,
  writeJobIntentStatus,
} from "../domain/workspaces/write-job-intent.js"
import {
  nextPersistedWriteProbe,
  probeWorkspaceWriteAccess,
} from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  failUnscheduledWriteJob,
  persistBoundWriteJob,
} from "../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  persistWriteJobIntent,
  persistWriteJobStatus,
  persistWriteStatus,
} from "../models/workspaces.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceBootstrap } from "./workflows/workspace-bootstrap.js"
import { workspaceClaimsUpgrade } from "./workflows/workspace-claims-upgrade.js"
import {
  workspaceFileEdit,
  workspaceFileEditInputSchema,
} from "./workflows/workspace-file-edit.js"
import { workspaceImportKeyCleanup } from "./workflows/workspace-import-key-cleanup.js"
import {
  workspaceLinkUnlink,
  workspaceLinkUnlinkInputSchema,
} from "./workflows/workspace-link-unlink.js"
import { workspaceOpsFolderMap } from "./workflows/workspace-ops-folder-map.js"
import { workspaceValidFromPersist } from "./workflows/workspace-valid-from-persist.js"
import { workspaceWriteCommit } from "./workflows/workspace-write-commit.js"

// Admission selects an explicit native workflow; it does not execute a job lifecycle.
const snapshotWriteWorkflows: Partial<
  Record<EnqueueWriteJobInput["kind"], typeof workspaceBootstrap>
> = {
  bootstrap: workspaceBootstrap,
  claims_upgrade: workspaceClaimsUpgrade,
  valid_from_persist: workspaceValidFromPersist,
  import_key_cleanup: workspaceImportKeyCleanup,
  ops_folder_map: workspaceOpsFolderMap,
}

type WorkspaceWriteSnapshot = {
  id: string
  desiredGeneration: number
  workspaceRepositoryUrl: string
  desiredSha: string | null
  writeStatus: string
  githubConnectionId?: string | null
}

async function probedWriteStatus(input: {
  orgId: string
  workspace: WorkspaceWriteSnapshot
}): Promise<string> {
  try {
    const { getGithubRepoWriteView } = await import(
      "../routes/webhooks/github/github-workspace-tip.js"
    )
    const probe = await probeWorkspaceWriteAccess({
      workspaceRepositoryUrl: input.workspace.workspaceRepositoryUrl,
      githubConnectionId: input.workspace.githubConnectionId,
      orgId: input.orgId,
      fetchWriteView: (args) =>
        getGithubRepoWriteView({
          ...args,
          env: parseEnv(process.env as Record<string, string | undefined>),
        }),
    })
    const write = nextPersistedWriteProbe({
      currentStatus: input.workspace.writeStatus,
      probe,
    })
    await withOrgDbContext(input.orgId, () =>
      persistWriteStatus(input.workspace.id, write, input.orgId),
    )
    return write.writeStatus
  } catch {
    return input.workspace.writeStatus
  }
}

export type EnqueueWorkspaceWriteCommitInput = EnqueueWriteJobInput

export async function enqueueWriteJob(
  input: EnqueueWriteJobInput,
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  assertNotInOrgDbContext()
  const jobId = input.jobId ?? generateObjectId("wjob")
  let jobGeneration = input.jobGeneration
  let jobWorkspaceUrl = input.jobWorkspaceUrl
  let jobDesiredSha = input.jobDesiredSha
  let writeStatus: string | null = null
  let desiredGeneration = jobGeneration
  try {
    const workspace = await withOrgDbContext(input.orgId, () =>
      getWorkspaceById(input.workspaceId),
    )
    if (workspace) {
      jobGeneration = jobGeneration ?? workspace.desiredGeneration
      jobWorkspaceUrl = jobWorkspaceUrl ?? workspace.workspaceRepositoryUrl
      if (jobDesiredSha === undefined) jobDesiredSha = workspace.desiredSha
      desiredGeneration = workspace.desiredGeneration
      writeStatus = await probedWriteStatus({
        orgId: input.orgId,
        workspace: {
          id: workspace.id,
          desiredGeneration: workspace.desiredGeneration,
          workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
          desiredSha: workspace.desiredSha,
          writeStatus: workspace.writeStatus,
          githubConnectionId: workspace.githubConnectionId,
        },
      })
    }
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)))
    return { started: false }
  }
  if (writeStatus == null) {
    log.error(new Error("Workspace write binding is unavailable"))
    return { started: false }
  }
  const snapshotWorkflow = snapshotWriteWorkflows[input.kind]
  if (
    (snapshotWorkflow ||
      input.kind === "ui_file_edit" ||
      input.kind === "link_unlink") &&
    writeStatus === "writable"
  ) {
    let bound = false
    try {
      const resolved = await resolveWorkspaceReadRevision({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        env: parseEnv(process.env),
      })
      if (!resolved) throw new Error("Workspace revision is unavailable")
      const revision = {
        ...resolved.revision,
        access: "write-default" as const,
      }
      if (
        (jobGeneration != null && revision.generation !== jobGeneration) ||
        (jobWorkspaceUrl && revision.remote.url !== jobWorkspaceUrl) ||
        (jobDesiredSha && revision.sha !== jobDesiredSha) ||
        (input.defaultBranch && revision.defaultBranch !== input.defaultBranch)
      )
        throw new Error("Write command binding changed during admission")
      if (input.kind === "link_unlink") {
        const command = workspaceLinkUnlinkInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          linkAction: input.linkAction,
          linkGitUrl: input.linkGitUrl,
        })
        await persistBoundWriteJob({
          id: jobId,
          kind: input.kind,
          revision,
          linkAction: command.linkAction,
          linkGitUrl: command.linkGitUrl,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceLinkUnlink.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (input.kind === "ui_file_edit") {
        const command = workspaceFileEditInputSchema.parse({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          jobId,
          revision,
          files: input.mergeFiles ?? [],
          deletePaths: input.mergeDeletePaths ?? [],
        })
        await persistBoundWriteJob({
          id: jobId,
          kind: input.kind,
          revision,
          files: command.files,
          deletePaths: command.deletePaths,
        })
        bound = true
        await runWorkflowWithWorkerWake(workspaceFileEdit.spec, command, {
          idempotencyKey: jobId,
        })
        return { started: true }
      }
      if (!snapshotWorkflow)
        throw new Error("No typed workflow for this write kind")
      const command = {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        jobId,
        revision,
        ...(input.kind === "ops_folder_map" && input.displayName !== undefined
          ? { displayName: input.displayName.trim() }
          : {}),
      }
      await persistBoundWriteJob({
        id: jobId,
        kind: input.kind,
        revision,
        displayName: command.displayName,
      })
      bound = true
      await runWorkflowWithWorkerWake(snapshotWorkflow.spec, command, {
        idempotencyKey: jobId,
      })
      return { started: true }
    } catch (error) {
      if (bound) {
        try {
          await failUnscheduledWriteJob(jobId)
        } catch (statusError) {
          log.error(
            statusError instanceof Error
              ? statusError
              : new Error(String(statusError)),
          )
        }
      }
      log.error(error instanceof Error ? error : new Error(String(error)))
      return { started: false }
    }
  }
  const generation = jobGeneration ?? desiredGeneration ?? 1
  const intent = writeJobIntentStatus({
    writeStatus,
    jobGeneration: generation,
    desiredGeneration: desiredGeneration ?? generation,
  })
  const status =
    intent === "stale_generation"
      ? WRITE_JOB_STATUSES.failed
      : intent === WRITE_JOB_STATUSES.paused
        ? WRITE_JOB_STATUSES.paused
        : WRITE_JOB_STATUSES.queued
  try {
    await withOrgDbContext(input.orgId, () =>
      persistWriteJobIntent({
        id: jobId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        generation,
        desiredSha: jobDesiredSha ?? null,
        status,
        payload: writeJobIntentPayload({
          kind: input.kind,
          displayName: input.displayName,
          defaultBranch: input.defaultBranch,
          linkAction: input.linkAction,
          linkGitUrl: input.linkGitUrl,
          jobWorkspaceUrl,
          conflictParentSha: input.conflictParentSha,
          remoteTipSha: input.remoteTipSha,
          mergeFiles: input.mergeFiles,
          mergeDeletePaths: input.mergeDeletePaths,
        }),
      }),
    )
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    if (status !== WRITE_JOB_STATUSES.queued) return { started: false }
  }
  if (status !== WRITE_JOB_STATUSES.queued) {
    return { started: false }
  }
  try {
    await runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
      ...input,
      jobId,
      ...(jobGeneration != null ? { jobGeneration } : {}),
      ...(jobWorkspaceUrl ? { jobWorkspaceUrl } : {}),
      ...(jobDesiredSha !== undefined ? { jobDesiredSha } : {}),
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      await withOrgDbContext(input.orgId, () =>
        persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.paused),
      )
    } catch {
      // Keep a resumable row even if this status write fails.
    }
    return { started: false }
  }
  return { started: true }
}

export const enqueueWorkspaceWriteCommit = enqueueWriteJob
